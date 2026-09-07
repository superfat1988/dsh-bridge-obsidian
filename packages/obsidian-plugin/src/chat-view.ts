/**
 * Chat panel: one conversation bound to one DSH session. Renders durable
 * session events (user/assistant messages, merged tool rows), a working
 * indicator between turn/start and turn/end, ask_user_question waterfalls as
 * a modal, and vault tool-call activity. History is re-fetched from the Host
 * on reconnect — the session lives on the NAS, not in the plugin.
 *
 * @module
 */

import { ItemView, MarkdownRenderer, Notice, Modal, Component } from "obsidian"
import type { App } from "obsidian"
import type DshBridgePlugin from './main.ts'
import type { TurnRecord } from './archive.ts'
import {
  appendLiveRow,
  completeLastTool,
  mergeHistoryRows,
  pendingQuestionFromFrame,
  resolvedQuestionFromFrame,
  rowFromEvent,
  toolSummary,
  textFromBlocks,
  type PendingQuestion,
  type Row,
  type SessionEventView,
} from './session-events.ts'

export const VIEW_TYPE_DSH_CHAT = 'dsh-bridge-obsidian-chat'

interface HistoryPage {
  events?: Array<{ event?: SessionEventView }>
  hasMore?: boolean
}

interface ModelSelectionView {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ModelCatalogView {
  default: ModelSelectionView
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  failures?: Array<{ id: string; name: string; message: string }>
}

export class DshChatView extends ItemView {
  private readonly plugin: DshBridgePlugin
  private readonly markdownComponent = new Component()
  private sessionId: string | null = null
  private busy = false
  private rows: Row[] = []
  private nextSeqValue = 1
  private messagesEl: HTMLElement | null = null
  private inputEl: HTMLTextAreaElement | null = null
  private sendBtn: HTMLButtonElement | null = null
  private statusEl: HTMLElement | null = null
  private pendingQuestion: PendingQuestion | null = null
  private sessionTitle: string | null = null
  private currentTurn: TurnRecord | null = null
  private catalog: ModelCatalogView | null = null
  private selectedModel: ModelSelectionView | null = null
  private modelSelectEl: HTMLSelectElement | null = null

  constructor(leaf: ItemView['leaf'], plugin: DshBridgePlugin) {
    super(leaf)
    this.plugin = plugin
  }

  getViewType(): string { return VIEW_TYPE_DSH_CHAT }
  getDisplayText(): string { return 'DSH 对话' }
  getIcon(): string { return 'dsh-mark' }

  /** @returns the vault name presented in hello. */
  get vaultName(): string {
    return this.app.vault.getName()
  }

  async onOpen(): Promise<void> {
    const content = this.contentEl
    content.empty()
    content.addClass('dsh-chat-container')

    const header = content.createDiv({ cls: 'dsh-chat-header' })
    this.statusEl = header.createSpan({ cls: 'dsh-chat-status', text: '连接中…' })
    this.modelSelectEl = header.createEl('select', { cls: 'dsh-model-select' })
    this.modelSelectEl.createEl('option', { text: '模型…', attr: { value: '' } })
    this.modelSelectEl.onchange = () => { void this.applySelectedModel() }
    const newChatBtn = header.createEl('button', { text: '新对话', cls: 'dsh-chat-new-btn' })
    newChatBtn.onclick = () => { void this.startNewChat() }

    this.messagesEl = content.createDiv({ cls: 'dsh-chat-messages' })

    const inputArea = content.createDiv({ cls: 'dsh-chat-input-area' })
    this.inputEl = inputArea.createEl('textarea', {
      cls: 'dsh-chat-input',
      attr: { placeholder: '向 DSH 提问，或让它修改笔记…（Enter 发送，Shift+Enter 换行）', rows: '3' },
    })
    this.inputEl.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void this.send()
      }
    }
    this.sendBtn = inputArea.createEl('button', { text: '发送', cls: 'dsh-chat-send mod-cta' })
    this.sendBtn.onclick = () => { void this.send() }

    this.renderRows()
    this.updateStatus()
  }

  async onClose(): Promise<void> {
    this.markdownComponent.unload()
  }

  /** Connection status changed; refresh the indicator. */
  updateStatus(): void {
    if (this.statusEl === null) return
    const client = this.plugin.client
    if (client.isReady()) {
      this.statusEl.setText(`已连接 · ${this.vaultName}`)
      this.statusEl.addClass('is-ok')
      this.statusEl.removeClass('is-bad')
      if (this.catalog === null) void this.loadCatalog()
    } else {
      this.statusEl.setText('未连接 — 检查设置中的地址与 token')
      this.statusEl.addClass('is-bad')
      this.statusEl.removeClass('is-ok')
    }
  }

  /** Fetch the host model catalog and populate the selector. */
  private async loadCatalog(): Promise<void> {
    const select = this.modelSelectEl
    if (select === null) return
    try {
      const catalog = await this.plugin.client.rpc<ModelCatalogView>('session.modelCatalog', {})
      this.catalog = catalog
      select.empty()
      const selection = this.selectedModel ?? catalog.default
      const valueOf = (sel: ModelSelectionView): string => JSON.stringify({ provider: sel.provider, model: sel.model })
      let matched = false
      for (const group of catalog.groups ?? []) {
        if (group.models.length === 0) continue
        const optgroup = select.createEl('optgroup', { attr: { label: group.name } })
        for (const model of group.models) {
          const value = valueOf({ provider: group.id, model: model.id })
          const option = optgroup.createEl('option', { text: model.name, attr: { value } })
          if (value === valueOf(selection)) {
            option.selected = true
            matched = true
          }
        }
      }
      if (!matched) {
        const option = select.createEl('option', {
          text: `${selection.provider}/${selection.model}`,
          attr: { value: valueOf(selection) },
        })
        option.selected = true
      }
      this.selectedModel = selection
    } catch (error) {
      console.warn('[dsh-bridge] model catalog unavailable:', error)
    }
  }

  /** Apply the dropdown selection: immediately for a live session, or stash it for the next one. */
  private async applySelectedModel(): Promise<void> {
    const select = this.modelSelectEl
    if (select === null || select.value === '') return
    let parsed: ModelSelectionView
    try {
      parsed = JSON.parse(select.value) as ModelSelectionView
    } catch {
      return
    }
    this.selectedModel = parsed
    if (this.sessionId === null) return
    try {
      const result = await this.plugin.client.rpc<{ selected?: ModelSelectionView }>('session.selectModel', {
        sessionId: this.sessionId,
        provider: parsed.provider,
        model: parsed.model,
      })
      if (result?.selected !== undefined) this.selectedModel = result.selected
      new Notice(`模型已切换：${result?.selected?.model ?? parsed.model}`)
    } catch (error) {
      new Notice(`模型切换失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Handle one bridge event frame (session event or question waterfall). */
  handleEvent(frame: { rpcId: string; method: string; payload: unknown }): void {
    const resolved = resolvedQuestionFromFrame(frame)
    if (resolved !== null) {
      if (this.pendingQuestion !== null && this.pendingQuestion.rpcId === resolved.rpcId) {
        this.pendingQuestion = null
      }
      return
    }
    const question = pendingQuestionFromFrame(frame)
    if (question !== null) {
      this.pendingQuestion = question
      this.showQuestionModal(question)
      return
    }
    if (frame.method !== 'session/event' || typeof frame.payload !== 'object' || frame.payload === null) return
    const payload = frame.payload as { sessionId?: unknown; event?: SessionEventView }
    if (typeof payload.sessionId !== 'string' || payload.event === undefined) return
    if (this.sessionId !== null && payload.sessionId !== this.sessionId) return
    // First live event binds the panel to that session (new chat flow).
    if (this.sessionId === null) this.sessionId = payload.sessionId

    const event = payload.event
    const seq = this.nextSeqValue
    this.nextSeqValue += 1
    switch (event.type) {
      case 'session/title': {
        const title = this.titleFromEvent(event)
        if (title !== null) this.sessionTitle = title
        break
      }
      case 'turn/start':
        this.busy = true
        this.currentTurn = {
          sessionId: payload.sessionId,
          sessionTitle: this.sessionTitle,
          model: this.selectedModel?.model ?? null,
          userText: '',
          assistantText: '',
          toolLines: [],
        }
        this.updateSendButton()
        break
      case 'turn/end':
        this.busy = false
        this.rows = completeLastTool(this.rows, seq)
        this.renderRows()
        this.updateSendButton()
        this.flushTurnArchive()
        break
      case 'tool/call': {
        const summary = toolSummary(event.data?.name ?? 'tool', event.data?.arguments)
        this.rows = appendLiveRow(this.rows, 'tool', summary, seq)
        this.currentTurn?.toolLines.push(summary)
        this.renderRows()
        break
      }
      case 'tool/result':
        this.rows = completeLastTool(this.rows, seq)
        this.renderRows()
        break
      case 'user/message':
      case 'assistant/message': {
        const row = rowFromEvent(event)
        if (row === null) break
        this.rows = appendLiveRow(this.rows, row.kind, row.text, seq)
        if (this.currentTurn !== null) {
          if (row.kind === 'user') this.currentTurn.userText = row.text
          else if (this.currentTurn.assistantText !== '') this.currentTurn.assistantText += `\n\n${row.text}`
          else this.currentTurn.assistantText = row.text
        }
        this.renderRows()
        break
      }
      default:
        break
    }
  }

  /** Defensive title reader for the `session/title` event (shape not contractual). */
  private titleFromEvent(event: SessionEventView): string | null {
    const data = event.data as { title?: unknown; name?: unknown } | undefined
    for (const candidate of [data?.title, data?.name]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return null
  }

  /** Append the finished turn to the vault archive when enabled. */
  private flushTurnArchive(): void {
    const turn = this.currentTurn
    this.currentTurn = null
    if (turn === null || this.plugin.settings.conversationArchive !== 'turn') return
    if (turn.userText.trim() === '' && turn.assistantText.trim() === '') return
    void this.plugin.archiveTurn(turn)
  }

  /** Manual archive: export the whole rendered conversation as one note. */
  async exportCurrentConversation(): Promise<void> {
    if (this.rows.length === 0) {
      new Notice('当前对话为空')
      return
    }
    const body = this.rows.map((row) => {
      if (row.kind === 'user') return `🧑 **你**：${row.text}`
      if (row.kind === 'assistant') return `🤖 **DSH**：\n\n${row.text}`
      if (row.kind === 'tool') return `> 🔧 ${row.text}`
      return `ℹ️ ${row.text}`
    }).join('\n\n')
    const path = await this.plugin.archiveExport(
      this.sessionTitle ?? '未命名对话',
      this.sessionId ?? '无会话',
      this.selectedModel?.model ?? null,
      body,
    )
    new Notice(`已导出对话：${path}`)
  }

  async startNewChat(): Promise<void> {
    this.sessionId = null
    this.busy = false
    this.rows = []
    this.sessionTitle = null
    this.currentTurn = null
    this.nextSeqValue = 1
    this.renderRows()
    this.updateSendButton()
    new Notice('已开启新对话（首次发送时创建会话）')
  }

  private async send(): Promise<void> {
    const input = this.inputEl
    if (input === null) return
    const text = input.value.trim()
    if (text === '' || this.busy) return
    if (!this.plugin.client.isReady()) {
      new Notice('桥未连接：请在设置中检查地址与 token')
      return
    }
    input.value = ''
    try {
      if (this.sessionId === null) {
        const created = await this.plugin.client.rpc<{ sessionId?: string }>('session.create', {})
        const createdId = typeof created === 'object' && created !== null && typeof created.sessionId === 'string'
          ? created.sessionId
          : String(created)
        this.sessionId = createdId
        // A fresh session starts on the catalog default; re-apply the picker's
        // selection before the first prompt lands.
        if (this.selectedModel !== null
          && (this.selectedModel.provider !== this.catalog?.default.provider
            || this.selectedModel.model !== this.catalog?.default.model)) {
          await this.plugin.client.rpc('session.selectModel', {
            sessionId: this.sessionId,
            provider: this.selectedModel.provider,
            model: this.selectedModel.model,
          })
        }
      }
      await this.plugin.client.rpc('session.prompt', {
        sessionId: this.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    } catch (error) {
      new Notice(`发送失败：${error instanceof Error ? error.message : String(error)}`)
      const seq = this.nextSeqValue
      this.nextSeqValue += 1
      this.rows = appendLiveRow(this.rows, 'info', `发送失败：${error instanceof Error ? error.message : String(error)}`, seq)
      this.renderRows()
    }
  }

  /** Re-fetch durable history from the Host (after reconnect or reopen). */
  async refreshHistory(): Promise<void> {
    if (this.sessionId === null || !this.plugin.client.isReady()) return
    try {
      const page = await this.plugin.client.rpc<HistoryPage>('session.history', { sessionId: this.sessionId })
      const events = (page.events ?? [])
        .map(entry => entry.event)
        .filter((event): event is SessionEventView => event !== undefined)
      this.rows = mergeHistoryRows(events, () => {
        const seq = this.nextSeqValue
        this.nextSeqValue += 1
        return seq
      })
      this.renderRows()
    } catch {
      // Unknown session (e.g. Host restarted): start fresh.
      this.sessionId = null
      this.rows = []
      this.renderRows()
    }
  }

  private updateSendButton(): void {
    if (this.sendBtn === null) return
    this.sendBtn.setText(this.busy ? '工作中…' : '发送')
    this.sendBtn.disabled = this.busy
  }

  private renderRows(): void {
    const container = this.messagesEl
    if (container === null) return
    container.empty()
    for (const row of this.rows) {
      if (row.kind === 'tool') {
        const toolEl = container.createDiv({ cls: 'dsh-chat-tool' })
        toolEl.setText(`${row.status === 'running' ? '⟳ ' : '✓ '}${row.text}`)
        continue
      }
      if (row.kind === 'info') {
        const infoEl = container.createDiv({ cls: 'dsh-chat-info' })
        infoEl.setText(row.text)
        continue
      }
      const rowEl = container.createDiv({ cls: `dsh-chat-row dsh-chat-${row.kind}` })
      const bubble = rowEl.createDiv({ cls: 'dsh-chat-bubble' })
      if (row.kind === 'assistant') {
        void MarkdownRenderer.render(this.app, row.text, bubble, '', this.markdownComponent)
      } else {
        bubble.setText(row.text)
      }
    }
    if (this.busy) {
      container.createDiv({ cls: 'dsh-chat-working', text: 'DSH 工作中…' })
    }
    container.scrollTop = container.scrollHeight
  }

  private showQuestionModal(question: PendingQuestion): void {
    void new QuestionModal(this.app, this.plugin, question).open()
  }
}

class QuestionModal extends Modal {
  private readonly plugin: DshBridgePlugin
  private readonly question: PendingQuestion
  private settled = false

  constructor(app: App, plugin: DshBridgePlugin, question: PendingQuestion) {
    super(app)
    this.plugin = plugin
    this.question = question
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h3', { text: this.question.header ?? 'DSH 请求确认' })
    contentEl.createEl('p', { text: this.question.question })

    const actions = contentEl.createDiv({ cls: 'dsh-question-actions' })
    for (const option of this.question.options) {
      const button = actions.createEl('button', { text: option.label, cls: 'mod-cta' })
      if (option.description !== undefined) button.setAttribute('aria-label', option.description)
      button.onclick = () => {
        void this.settle({ ok: true, value: { answers: [{ id: this.question.questionId, selected: [option.label] }] } })
      }
    }
    const cancel = actions.createEl('button', { text: '取消' })
    cancel.onclick = () => {
      void this.settle({ ok: false, error: { code: 'cancelled', message: '用户取消了该请求', details: {} } })
    }
  }

  onClose(): void {
    // Unanswered modal: cancel the waterfall so the session does not hang.
    if (!this.settled) {
      void this.plugin.client.respond(this.question.rpcId, {
        ok: false,
        error: { code: 'cancelled', message: '用户取消了该请求', details: {} },
      })
    }
    this.contentEl.empty()
  }

  private async settle(result: Parameters<DshBridgePlugin['client']['respond']>[1]): Promise<void> {
    if (this.settled) return
    this.settled = true
    await this.plugin.client.respond(this.question.rpcId, result)
    this.close()
  }
}

/** Exported for main.ts: expose the text-block helper used by vault summaries. */
export { textFromBlocks }
