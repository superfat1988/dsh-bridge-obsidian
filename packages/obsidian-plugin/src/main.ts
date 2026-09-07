/**
 * dsh-bridge-obsidian — Obsidian plugin entry.
 *
 * Connects to the DSH bridge WebSocket, executes `obsidian_*` vault tool
 * calls locally via the Obsidian Vault API (subject to the write-approval
 * setting), and hosts the DSH chat panel view.
 *
 * @module
 */

import { Modal, Notice, Plugin, TFile, addIcon } from "obsidian"
import type { App } from "obsidian"
import { appendTurn, exportConversation, type TurnRecord } from './archive.ts'
import { DshChatView, VIEW_TYPE_DSH_CHAT } from './chat-view.ts'
import { BridgeClient, discoverBridgeUrl, type ToolCallRequest } from './connection.ts'
import { DSH_MARK_SVG } from './icon.ts'
import { scanVaultSkills } from './skills-scan.ts'
import { DEFAULT_SETTINGS, DshBridgeSettingTab, type DshBridgeSettings } from './settings.ts'
import { executeToolCall } from './vault.ts'

export default class DshBridgePlugin extends Plugin {
  settings: DshBridgeSettings = DEFAULT_SETTINGS
  client = new BridgeClient()
  private chatView: DshChatView | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()
    // Register the DSH monochrome mark before any view/ribbon uses it.
    addIcon('dsh-mark', DSH_MARK_SVG)
    this.addSettingTab(new DshBridgeSettingTab(this.app, this))

    // Vault tool executor: runs in the client, gated by the approval setting.
    this.client.onToolCall = async (call: ToolCallRequest) => {
      const result = await executeToolCall(
        this.app,
        {
          writeApproval: this.settings.writeApproval,
          maxReadChars: this.client.caps.maxReadChars,
          searchLimit: this.client.caps.searchLimit,
        },
        call.name,
        call.args,
        async (path, content, mode) => await this.confirmWrite(path, content, mode),
      )
      // Surface vault activity as a notice so the user sees agent writes even
      // when the chat panel is closed.
      if (call.name === 'obsidian_write_note') new Notice(`DSH 已写入笔记：${String(call.args['path'] ?? '')}`)
      return result
    }
    this.client.onEvent = frame => this.chatView?.handleEvent(frame)
    this.client.onStatus = () => {
      this.chatView?.updateStatus()
      // The socket came back: durable history lives on the Host, re-fetch it
      // and (re)publish the vault skills manifest for bridge-session injection.
      if (this.client.isReady()) {
        void this.chatView?.refreshHistory()
        void this.publishSkills()
      }
    }

    this.registerView(VIEW_TYPE_DSH_CHAT, leaf => {
      this.chatView = new DshChatView(leaf, this)
      return this.chatView
    })

    const ribbon = this.addRibbonIcon("dsh-mark", "打开 DSH 对话", () => {
      void this.activateView()
    })
    ribbon.addClass('dsh-bridge-ribbon')

    this.addCommand({ id: 'open-chat', name: '打开 DSH 对话', callback: () => { void this.activateView() } })
    this.addCommand({ id: 'reconnect', name: '重新连接 DSH 桥', callback: () => { void this.reconnect() } })
    this.addCommand({ id: 'new-chat', name: '新建 DSH 对话', callback: () => {
      void this.activateView().then(() => this.chatView?.startNewChat())
    } })
    this.addCommand({ id: 'archive-chat', name: '存档当前对话', callback: () => {
      void this.activateView().then(() => this.chatView?.exportCurrentConversation())
    } })
    this.addCommand({ id: 'rescan-skills', name: '重新扫描 vault Skills', callback: () => {
      void this.publishSkills()
    } })

    if (this.settings.autoConnect && this.settings.token !== '') {
      void this.reconnect()
    }
  }

  override onunload(): void {
    this.client.stop()
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData()
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data)
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  /** (Re)connect the bridge using current settings. */
  async reconnect(): Promise<void> {
    if (this.settings.token === '') {
      new Notice('请先在设置中填写桥接 token（NAS 上 ~/.dsh/obsidian-bridge-token）')
      return
    }
    const wsUrl = await discoverBridgeUrl(this.settings.bridgeBase)
    this.client.start(wsUrl, this.settings.token, this.app.vault.getName())
    new Notice(`正在连接 DSH 桥：${wsUrl}`)
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_DSH_CHAT)[0] ?? null
    const leaf = existing ?? workspace.getRightLeaf(true)
    if (leaf !== null) {
      await leaf.setViewState({ type: VIEW_TYPE_DSH_CHAT, active: true })
      workspace.revealLeaf(leaf)
      this.chatView?.updateStatus()
    }
  }

  /** Scan the vault skills tree and publish the manifest to the bridge. */
  async publishSkills(): Promise<number> {
    try {
      const skills = await scanVaultSkills(this.app, this.settings.archiveFolder)
      if (skills.length > 0) this.client.sendSkillsManifest(skills)
      return skills.length
    } catch (error) {
      console.warn('[dsh-bridge] skills scan failed:', error)
      return 0
    }
  }

  /** Append one finished turn to the vault archive (auto mode). */
  async archiveTurn(turn: TurnRecord): Promise<void> {
    if (this.settings.conversationArchive === 'off') return
    try {
      await appendTurn(this.app, this.settings.archiveFolder, turn)
    } catch (error) {
      console.warn('[dsh-bridge] archive failed:', error)
      new Notice(`会话存档失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Manual export: write the whole rendered conversation to one note. */
  async archiveExport(title: string, sessionId: string, model: string | null, body: string): Promise<string> {
    return await exportConversation(this.app, this.settings.archiveFolder, title, sessionId, model, body)
  }

  /** Write-approval modal: resolves true when the user allows the write. */
  private confirmWrite(path: string, content: string, mode: 'overwrite' | 'append'): Promise<boolean> {
    const existing = this.app.vault.getAbstractFileByPath(path)
    const isExisting = existing !== null && existing instanceof TFile
    const preview = content.length > 800 ? `${content.slice(0, 800)}\n…（共 ${content.length} 字符）` : content
    const verb = mode === 'append' ? '追加' : isExisting ? '覆盖' : '新建'
    return new Promise<boolean>((resolve) => {
      new WriteConfirmModal(this.app, {
        title: `DSH 请求${verb}笔记`,
        path,
        preview,
        onAllow: () => resolve(true),
        onDeny: () => resolve(false),
      }).open()
    })
  }
}

class WriteConfirmModal extends Modal {
  private readonly title: string
  private readonly path: string
  private readonly preview: string
  private readonly onAllow: () => void
  private readonly onDeny: () => void
  private settled = false

  constructor(app: App, options: { title: string; path: string; preview: string; onAllow: () => void; onDeny: () => void }) {
    super(app)
    this.title = options.title
    this.path = options.path
    this.preview = options.preview
    this.onAllow = options.onAllow
    this.onDeny = options.onDeny
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h3', { text: this.title })
    contentEl.createEl('p', { text: `路径：${this.path}` })
    const pre = contentEl.createEl('pre', { cls: 'dsh-write-preview' })
    pre.setText(this.preview)
    const actions = contentEl.createDiv({ cls: 'dsh-question-actions' })
    const allow = actions.createEl('button', { text: '允许写入', cls: 'mod-warning' })
    allow.onclick = () => { this.settle(true) }
    const deny = actions.createEl('button', { text: '拒绝' })
    deny.onclick = () => { this.settle(false) }
  }

  onClose(): void {
    if (!this.settled) this.onDeny()
    this.contentEl.empty()
  }

  private settle(allowed: boolean): void {
    if (this.settled) return
    this.settled = true
    if (allowed) this.onAllow()
    else this.onDeny()
    this.close()
  }
}
