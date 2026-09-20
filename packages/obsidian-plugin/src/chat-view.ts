/**
 * Chat panel: one conversation bound to one DSH session. Renders durable
 * session events (user/assistant messages, merged tool rows), a working
 * indicator between turn/start and turn/end, ask_user_question waterfalls as
 * a modal, and vault tool-call activity. History is re-fetched from the Host
 * on reconnect — the session lives on the NAS, not in the plugin.
 *
 * @module
 */

import { ItemView, MarkdownRenderer, Notice, Modal, Component, Setting, setIcon } from "obsidian"
import type { App } from "obsidian"
import { DSH_MARK_SVG } from './icon.ts'
import type DshBridgePlugin from './main.ts'
import { listArchivedConversations, type TurnRecord } from './archive.ts'
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
// Vendored from dsh-bridge-browser, kept byte-identical and verified by hash;
// see src/vendor/upstream/README.md for the sync contract.
import { AssistantStreamView, type StreamUpdate } from './vendor/upstream/assistant-stream.ts'

export const VIEW_TYPE_DSH_CHAT = 'dsh-bridge-obsidian-chat'

interface HistoryPage {
  events?: Array<{ event?: SessionEventView }>
  hasMore?: boolean
  /**
   * In-flight Assistant attempt opening, present only when the Host was asked
   * for the live stream and one is running. Seeding the live view from this
   * restores the answer's opening text on reopen/reconnect.
   */
  assistantStream?: unknown
  /** Correlates this response with the pushed baseline that carries it. */
  snapshotId?: string
}

interface ModelSelectionView {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ModelCatalogView {
  default: ModelSelectionView
  groups: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      reasoning?: {
        efforts: Array<{ id: string; name: string; description?: string }>
        defaultEffort?: string
      }
    }>
  }>
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
  private modelChipEl: HTMLButtonElement | null = null
  private modelPopoverEl: HTMLElement | null = null
  /**
   * Live assistant text, owned by the vendored upstream state machine instead
   * of an ad-hoc buffer. One view per session key; the panel only ever renders
   * the view belonging to its current session, so switching sessions cannot
   * resurface a previous session's half-finished answer.
   */
  private readonly streamViews = new Map<string, AssistantStreamView>()
  /**
   * Snapshot ids whose pushed baseline has already been applied to a stream
   * view. A history response carrying the same id must not re-seed: doing so
   * would rebuild the view from the baseline and discard any live suffix chunk
   * that arrived in the meantime.
   */
  private readonly appliedSnapshots = new Set<string>()
  /** Live streaming text currently rendered, if any. */
  private liveText = ''
  private liveBubbleEl: HTMLElement | null = null

  /**
   * Remember one applied snapshot id, keeping the set small.
   *
   * Correlation only needs to survive the window between a pushed baseline and
   * the history response that raced it, so the set is trimmed rather than left
   * to grow for the life of a long-lived panel.
   * @param snapshotId - id of the baseline that was just applied.
   */
  private rememberSnapshot(snapshotId: string): void {
    this.appliedSnapshots.add(snapshotId)
    while (this.appliedSnapshots.size > 32) {
      const oldest = this.appliedSnapshots.values().next().value
      if (oldest === undefined) break
      this.appliedSnapshots.delete(oldest)
    }
  }

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
    // Critical layout is applied inline: styles.css is progressive polish,
    // never a load-bearing dependency (stale-cache-proof).
    // Bottom padding reserves space for Obsidian's floating status bar, which
    // overlays view content in both docked-right and centered positions.
    content.setCssStyles({ display: 'flex', flexDirection: 'column', height: '100%', padding: '10px 10px 40px', boxSizing: 'border-box', gap: '8px' })

    // Output window (top): conversation rows; empty state shows the DSH card.
    this.messagesEl = content.createDiv({ cls: 'dsh-chat-messages' })
    this.messagesEl.setCssStyles({ flex: '1 1 auto', overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '4px 2px' })

    // Toolbar row above the input, Copilot-style: status left, icons right.
    const toolbar = content.createDiv({ cls: 'dsh-chat-toolbar' })
    toolbar.setCssStyles({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' })
    this.statusEl = toolbar.createSpan({ cls: 'dsh-chat-status', text: '连接中…' })
    this.statusEl.setCssStyles({ fontSize: '12px', color: 'var(--text-muted)' })
    const tools = toolbar.createDiv({ cls: 'dsh-chat-tools' })
    tools.setCssStyles({ display: 'flex', alignItems: 'center', gap: '4px' })
    const toolStyle = 'width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;color:var(--icon-color);cursor:pointer'
    const newChatBtn = tools.createEl('div', { cls: 'dsh-tool-icon', attr: { 'aria-label': '新对话（新建一个 DSH 会话）', title: '新对话' } })
    newChatBtn.setCssStyles({ cssText: toolStyle })
    setIcon(newChatBtn, 'plus')
    newChatBtn.onclick = () => { void this.startNewChat() }
    const settingsBtn = tools.createEl('div', { cls: 'dsh-tool-icon', attr: { 'aria-label': '聊天设置（存档与写审批）', title: '聊天设置' } })
    settingsBtn.setCssStyles({ cssText: toolStyle })
    setIcon(settingsBtn, 'settings')
    settingsBtn.onclick = () => { void new ChatSettingsModal(this.app, this.plugin).open() }
    const historyBtn = tools.createEl('div', { cls: 'dsh-tool-icon', attr: { 'aria-label': '历史会话（从 DSH 恢复）', title: '历史会话' } })
    historyBtn.setCssStyles({ cssText: toolStyle })
    setIcon(historyBtn, 'history')
    historyBtn.onclick = () => { void new HistoryModal(this.app, this.plugin, this).open() }

    // Input box with the model picker and circular send button inside.
    const inputBox = content.createDiv({ cls: 'dsh-chat-input-box' })
    inputBox.setCssStyles({ border: '1px solid var(--background-modifier-border)', borderRadius: '10px', padding: '8px', background: 'var(--background-primary)' })
    this.inputEl = inputBox.createEl('textarea', {
      cls: 'dsh-chat-input',
      attr: { placeholder: '向 DSH 提问，或让它修改笔记…（Enter 发送，Shift+Enter 换行）', rows: '3' },
    })
    this.inputEl.setCssStyles({ width: '100%', border: 'none', background: 'transparent', boxShadow: 'none', resize: 'none' })
    this.inputEl.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void this.send()
      }
    }
    const inputRow = inputBox.createDiv({ cls: 'dsh-chat-input-row' })
    inputRow.setCssStyles({ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' })
    // DSH-style model chip: "model effort ^" pill that opens a popover menu.
    this.modelChipEl = inputRow.createEl('button', { cls: 'dsh-model-chip', attr: { 'aria-label': '选择模型与推理等级', title: '选择模型与推理等级' } })
    this.modelChipEl.setCssStyles({ display: 'flex', alignItems: 'center', gap: '6px', border: '1px solid var(--background-modifier-border)', background: 'var(--background-secondary)', borderRadius: '8px', padding: '3px 10px', fontSize: '13px', color: 'var(--text-normal)', cursor: 'pointer' })
    this.renderModelChip()
    this.modelChipEl.onclick = () => { this.toggleModelPopover() }
    this.sendBtn = inputRow.createEl('button', { cls: 'dsh-chat-send', attr: { 'aria-label': '发送', title: '发送' } })
    this.sendBtn.setCssStyles({ marginLeft: 'auto', width: '30px', height: '30px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0', border: 'none', background: 'var(--interactive-accent)', color: 'var(--text-on-accent)', cursor: 'pointer' })
    setIcon(this.sendBtn, 'arrow-up')

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

  /** Fetch the host model catalog and render the model chip. */
  private async loadCatalog(): Promise<void> {
    if (this.modelChipEl === null) return
    try {
      const catalog = await this.plugin.client.rpc<ModelCatalogView>('session.modelCatalog', {})
      this.catalog = catalog
      if (this.selectedModel === null) this.selectedModel = catalog.default
      this.renderModelChip()
    } catch (error) {
      console.warn('[dsh-bridge] model catalog unavailable:', error)
    }
  }

  /** Reflect the current selection onto the chip (model bold + effort muted). */
  private renderModelChip(): void {
    const chip = this.modelChipEl
    if (chip === null) return
    chip.empty()
    const sel = this.selectedModel
    if (sel === null) {
      chip.createSpan({ text: '模型…' })
      return
    }
    chip.createSpan({ text: sel.model, cls: 'dsh-chip-model' })
    if (sel.reasoningEffort !== undefined && sel.reasoningEffort !== '') {
      chip.createSpan({ text: sel.reasoningEffort, cls: 'dsh-chip-effort' })
    }
    const chevron = chip.createSpan({ cls: 'dsh-chip-chevron' })
    setIcon(chevron, 'chevron-up')
  }

  /** Toggle the DSH-style model popover anchored above the chip. */
  private toggleModelPopover(): void {
    if (this.modelPopoverEl !== null) {
      this.closeModelPopover()
      return
    }
    const chip = this.modelChipEl
    if (chip === null) return
    const rect = chip.getBoundingClientRect()
    const pop = document.body.createDiv({ cls: 'dsh-model-popover' })
    pop.setCssStyles({
      position: 'fixed',
      bottom: `${window.innerHeight - rect.top + 8}px`,
      left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`,
      width: '300px',
      maxHeight: '380px',
      overflowY: 'auto',
      background: 'var(--background-primary)',
      border: '1px solid var(--background-modifier-border)',
      borderRadius: '12px',
      padding: '6px',
      zIndex: '1000',
    })
    this.modelPopoverEl = pop
    this.renderPopoverRoot(pop)
    // Capture phase: this must run BEFORE a row's own click handler — rows
    // synchronously re-render the popover, which detaches the clicked node,
    // and a bubble-phase containment check would then wrongly close it.
    const outside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (this.modelPopoverEl !== null && !this.modelPopoverEl.contains(target)
        && !(chip !== null && chip.contains(target))) {
        this.closeModelPopover()
      }
    }
    document.addEventListener('click', outside, { capture: true })
    pop.addEventListener('destroy', () => document.removeEventListener('click', outside, { capture: true }))
  }

  private closeModelPopover(): void {
    this.modelPopoverEl?.dispatchEvent(new Event('destroy'))
    this.modelPopoverEl?.remove()
    this.modelPopoverEl = null
  }

  /** Root rows: 模型 / 推理等级, DSH Web popover style. */
  private renderPopoverRoot(pop: HTMLElement): void {
    pop.empty()
    const sel = this.selectedModel
    const modelRow = this.popoverRow(pop, '模型', sel?.model ?? '…')
    modelRow.onclick = () => this.renderPopoverModels(pop)
    const efforts = this.currentEfforts()
    const effortValue = efforts === null ? '默认' : (sel?.reasoningEffort ?? '默认')
    const effortRow = this.popoverRow(pop, '推理等级', effortValue)
    if (efforts === null) effortRow.setCssStyles({ opacity: '0.45' })
    else effortRow.onclick = () => this.renderPopoverEfforts(pop)
  }

  /** Model list grouped by provider (provider name as a header row). */
  private renderPopoverModels(pop: HTMLElement): void {
    pop.empty()
    const back = this.popoverBackRow(pop, '模型')
    back.onclick = () => this.renderPopoverRoot(pop)
    for (const group of this.catalog?.groups ?? []) {
      if (group.models.length === 0) continue
      pop.createDiv({ cls: 'dsh-pop-group', text: group.name })
      for (const model of group.models) {
        const isCurrent = this.selectedModel?.provider === group.id && this.selectedModel?.model === model.id
        const row = this.popoverRow(pop, model.id, isCurrent ? '✓' : '')
        row.onclick = () => { void this.chooseModel(group.id, model.id) }
      }
    }
  }

  /** Reasoning effort list for the selected model. */
  private renderPopoverEfforts(pop: HTMLElement): void {
    pop.empty()
    const back = this.popoverBackRow(pop, '推理等级')
    back.onclick = () => this.renderPopoverRoot(pop)
    const efforts = this.currentEfforts()
    if (efforts === null || efforts.length === 0) {
      pop.createDiv({ cls: 'dsh-pop-group', text: '当前模型无可选推理等级' })
      return
    }
    for (const effort of efforts) {
      const isCurrent = this.selectedModel?.reasoningEffort === effort.id
      const row = this.popoverRow(pop, effort.name, isCurrent ? '✓' : '')
      row.onclick = () => { void this.chooseEffort(effort.id) }
    }
  }

  /** One popover row: label left, value right-aligned muted, chevron right. */
  private popoverRow(pop: HTMLElement, label: string, value: string): HTMLElement {
    const row = pop.createDiv({ cls: 'dsh-pop-row' })
    row.setCssStyles({ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' })
    row.createSpan({ text: label })
    if (value !== '') {
      const valueEl = row.createSpan({ text: value })
      valueEl.setCssStyles({ marginLeft: 'auto', color: value === '✓' ? 'var(--text-accent)' : 'var(--text-muted)' })
    }
    const chevron = row.createSpan({})
    chevron.setCssStyles({ marginLeft: value === '' ? 'auto' : '4px', color: 'var(--text-faint)', display: 'flex' })
    setIcon(chevron, 'chevron-right')
    return row
  }

  private popoverBackRow(pop: HTMLElement, label: string): HTMLElement {
    const row = pop.createDiv({ cls: 'dsh-pop-back' })
    row.setCssStyles({ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', color: 'var(--text-muted)' })
    const chevron = row.createSpan({})
    chevron.setCssStyles({ display: 'flex', transform: 'rotate(180deg)' })
    setIcon(chevron, 'chevron-right')
    row.createSpan({ text: label })
    return row
  }

  /** Reasoning metadata of the currently selected model, or null. */
  private currentEfforts(): Array<{ id: string; name: string; description?: string }> | null {
    if (this.selectedModel === null || this.catalog === null) return null
    for (const group of this.catalog.groups ?? []) {
      if (group.id !== this.selectedModel.provider) continue
      const model = group.models.find(m => m.id === this.selectedModel?.model)
      return model?.reasoning?.efforts?.slice() ?? null
    }
    return null
  }

  /** Select a model (applies to the live session, or stashes for the next one). */
  private async chooseModel(provider: string, model: string): Promise<void> {
    this.selectedModel = { provider, model }
    this.renderModelChip()
    this.closeModelPopover()
    await this.pushSelection()
  }

  /** Select a reasoning effort for the current model. */
  private async chooseEffort(effortId: string): Promise<void> {
    if (this.selectedModel === null) return
    this.selectedModel = { ...this.selectedModel, reasoningEffort: effortId }
    this.renderModelChip()
    this.closeModelPopover()
    await this.pushSelection()
  }

  /** Push the selection to the live session (silent when none is bound yet). */
  private async pushSelection(): Promise<void> {
    const sel = this.selectedModel
    if (sel === null || this.sessionId === null) return
    try {
      const result = await this.plugin.client.rpc<{ selected?: ModelSelectionView }>('session.selectModel', {
        sessionId: this.sessionId,
        provider: sel.provider,
        model: sel.model,
        ...(sel.reasoningEffort !== undefined ? { reasoningEffort: sel.reasoningEffort } : {}),
      })
      if (result?.selected !== undefined) {
        this.selectedModel = result.selected
        this.renderModelChip()
      }
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
    if (frame.method === 'session/assistant-stream' && typeof frame.payload === 'object' && frame.payload !== null) {
      // Pass snapshotId through: it is what lets a pushed baseline and the
      // history response that raced it be recognized as the same opening.
      this.handleAssistantStream(frame.payload as { sessionId?: unknown; frame?: unknown; snapshotId?: unknown })
      return
    }
    if (frame.method !== 'session/event' || typeof frame.payload !== 'object' || frame.payload === null) return
    const payload = frame.payload as { sessionId?: unknown; event?: SessionEventView }
    if (typeof payload.sessionId !== 'string' || payload.event === undefined) return
    if (this.sessionId !== null && payload.sessionId !== this.sessionId) return
    // First live event binds the panel to that session (new chat flow).
    if (this.sessionId === null) this.sessionId = payload.sessionId

    const event = payload.event
    // A durable event supersedes the transient stream text it settles; do this
    // before rendering so the bubble never outlives the message that replaced it.
    if (this.streamViews.get(payload.sessionId)?.settle(event) === true) this.syncLiveText()
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
        // A durable assistant message supersedes the live text it settles; the
        // state machine already recorded that settlement above, so re-derive
        // rather than clearing the buffer directly — a message that does not
        // belong to the active attempt must leave still-streaming text alone.
        if (row.kind === 'assistant') this.syncLiveText()
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
    // Drop the previous session's rendered live bubble: the new session has no
    // stream view yet, and leaving the old text in place would show one
    // session's half-finished answer under another session's header.
    this.resetRenderedLiveState()
    this.renderRows()
    this.updateSendButton()
    new Notice('已开启新对话（首次发送时创建会话）')
  }

  /** Context block prepended to prompts when a note is open in the editor. */
  /** Context block prepended to prompts when a note is open in the editor. */
  private buildContextPrefix(): string {
    const active = this.app.workspace.getActiveFile()
    if (active === null) return ''
    return `<context>当前打开的笔记（vault 相对路径）：${active.path}\n如需读取或修改"当前文档"，直接对该路径使用 obsidian_read_note / obsidian_write_note。</context>\n\n`
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
        // A fresh session starts on the catalog default; re-apply the chip's
        // selection (model + effort) before the first prompt lands.
        await this.pushSelection()
      }
      // Active-note context: "当前文档" instructions need a concrete path.
      const promptText = this.plugin.settings.injectActiveNote
        ? this.buildContextPrefix() + text
        : text
      await this.plugin.client.rpc('session.prompt', {
        sessionId: this.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
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
    const boundSession = this.sessionId
    try {
      const page = await this.plugin.client.rpc<HistoryPage>('session.history', { sessionId: boundSession })
      // The panel may have moved on while this was in flight; a late response
      // for a previous session must not overwrite the current one.
      if (this.sessionId !== boundSession) return
      const events = (page.events ?? [])
        .map(entry => entry.event)
        .filter((event): event is SessionEventView => event !== undefined)
      this.rows = mergeHistoryRows(events, () => {
        const seq = this.nextSeqValue
        this.nextSeqValue += 1
        return seq
      })
      // Seed the live view from the Host baseline when an attempt is already
      // running, so the opening text is present even though its chunks were
      // emitted before this panel attached. Skip when the pushed baseline for
      // this very snapshot already landed — re-seeding would rebuild the view
      // and discard a suffix chunk that arrived in the meantime.
      const alreadyApplied = page.snapshotId !== undefined && this.appliedSnapshots.has(page.snapshotId)
      if (page.assistantStream !== undefined && !alreadyApplied) {
        const stream = this.streamViews.get(boundSession) ?? new AssistantStreamView()
        stream.replace(page.assistantStream)
        this.streamViews.set(boundSession, stream)
      }
      this.syncLiveText()
      this.renderRows()
    } catch {
      if (this.sessionId !== boundSession) return
      // Unknown session (e.g. Host restarted): start fresh.
      this.sessionId = null
      this.rows = []
      this.resetRenderedLiveState()
      this.renderRows()
    }
  }

  /** Bind the panel to an existing Host session and render its history. */
  async restoreSession(sessionId: string): Promise<void> {
    this.sessionId = sessionId
    this.rows = []
    this.sessionTitle = null
    this.nextSeqValue = 1
    // `busy` describes the session that was bound, not the one being restored.
    // Carrying it over would leave the send button disabled on a session that
    // is not running; live turn events re-establish the real state.
    this.busy = false
    this.updateSendButton()
    this.resetRenderedLiveState()
    await this.refreshHistory()
    if (this.rows.length === 0) new Notice('该会话没有可恢复的内容')
  }

  private updateSendButton(): void {
    if (this.sendBtn === null) return
    this.sendBtn.disabled = this.busy
    setIcon(this.sendBtn, this.busy ? 'loader' : 'arrow-up')
  }

  /**
   * The state-machine view owning the current session's live attempt.
   * @returns that view, or null when no session is bound or none exists yet.
   */
  private currentStreamView(): AssistantStreamView | null {
    return this.sessionId === null ? null : this.streamViews.get(this.sessionId) ?? null
  }

  /**
   * Re-derive rendered live text from the current session's view.
   *
   * This is the single source of truth for the streaming bubble: a view that
   * has settled, rebaselined, or does not belong to the current session yields
   * no text, so a switch can never resurface another session's stale answer.
   */
  private syncLiveText(): void {
    this.liveText = this.currentStreamView()?.row()?.text ?? ''
  }

  /** Drop rendered live state and re-derive it for the newly bound session. */
  private resetRenderedLiveState(): void {
    this.liveBubbleEl?.remove()
    this.liveBubbleEl = null
    this.syncLiveText()
  }

  /**
   * Live assistant stream: snapshot baselines and attempt frames feed the
   * vendored state machine, which owns the partial text and settlement rules.
   */
  private handleAssistantStream(payload: { sessionId?: unknown; frame?: unknown; snapshotId?: unknown }): void {
    const { sessionId, frame } = payload
    if (typeof sessionId !== 'string') return
    if (typeof frame !== 'object' || frame === null) return
    // First live frame binds the panel to that session (new-chat flow).
    if (this.sessionId === null) this.sessionId = sessionId
    let stream = this.streamViews.get(sessionId)
    if (stream === undefined) {
      stream = new AssistantStreamView()
      this.streamViews.set(sessionId, stream)
    }
    const value = frame as { type?: unknown; baseline?: unknown }
    let update: StreamUpdate
    if (value.type === 'snapshot') {
      // Record before applying: the matching history response may already be
      // queued on the RPC channel and must not re-seed over this baseline.
      if (typeof payload.snapshotId === 'string') this.rememberSnapshot(payload.snapshotId)
      update = stream.replace(value.baseline)
    } else {
      update = stream.accept(value)
    }
    if (sessionId !== this.sessionId) return
    this.syncLiveText()
    // Chunks arrive far faster than a repaint is wanted: reuse the mounted
    // bubble when it is still attached, and fall back to a full re-render only
    // when the row set actually changed (start/end/rebuild). A now-empty live
    // text means the attempt settled or rebaselined, so the bubble is removed
    // rather than left as a blank row.
    if (this.liveText === '') {
      this.liveBubbleEl?.remove()
      this.liveBubbleEl = null
      this.renderRows()
    } else if (this.liveBubbleEl !== null && this.liveBubbleEl.isConnected) {
      this.liveBubbleEl.setText(this.liveText)
    } else {
      this.renderRows()
    }
    // Rebaseline means the frame sequence had a gap the machine cannot repair;
    // durable history is the only trustworthy source at that point.
    if (update === 'rebaseline') void this.refreshHistory()
  }

  /** Re-append the live streaming bubble after a full re-render. */
  private appendLiveBubble(container: HTMLElement): void {
    if (this.liveText === '') return
    const rowEl = container.createDiv({ cls: 'dsh-chat-row dsh-chat-assistant' })
    this.liveBubbleEl = rowEl.createDiv({ cls: 'dsh-chat-bubble is-live' })
    this.liveBubbleEl.setText(this.liveText)
  }

  private renderRows(): void {
    const container = this.messagesEl
    if (container === null) return
    container.empty()
    if (this.rows.length === 0) {
      const card = container.createDiv({ cls: 'dsh-chat-empty' })
      card.setCssStyles({ margin: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '28px 32px', border: '1px solid var(--background-modifier-border)', borderRadius: '14px' })
      const mark = card.createDiv({ cls: 'dsh-chat-empty-mark' })
      mark.setCssStyles({ color: 'var(--interactive-accent)' })
      mark.innerHTML = DSH_MARK_SVG
      const svgEl = mark.querySelector('svg')
      svgEl?.setAttribute('width', '56')
      svgEl?.setAttribute('height', '56')
      card.createDiv({ cls: 'dsh-chat-empty-title', text: 'DeepSeek Harness' })
        .setCssStyles({ fontSize: '16px', fontWeight: '600' })
      card.createDiv({ cls: 'dsh-chat-empty-sub', text: '向 DSH 提问，或让它读写你的笔记' })
        .setCssStyles({ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' })
      return
    }
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
    if (this.busy || this.liveText !== '') this.appendLiveBubble(container)
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
  /** Per-question state: selected option labels + custom text. */
  private readonly selected: Set<string>[] = []
  private readonly custom: string[] = []

  constructor(app: App, plugin: DshBridgePlugin, question: PendingQuestion) {
    super(app)
    this.plugin = plugin
    this.question = question
    for (const item of question.items) {
      this.selected.push(new Set())
      this.custom.push('')
    }
  }

  onOpen(): void {
    this.renderContent()
  }

  private renderContent(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h3', { text: 'DSH 请求确认' })
    for (const [index, item] of this.question.items.entries()) {
      const block = contentEl.createDiv({ cls: 'dsh-question-block' })
      if (this.question.items.length > 1 || item.header !== undefined) {
        block.createEl('h4', { text: item.header ?? `问题 ${index + 1}` })
      }
      block.createEl('p', { text: item.question })

      const options = block.createDiv({ cls: 'dsh-question-actions' })
      for (const option of item.options) {
        const isSelected = this.selected[index]?.has(option.label) === true
        const button = options.createEl('button', {
          text: option.label,
          cls: `dsh-question-option${isSelected ? ' is-selected' : ''}`,
        })
        if (option.description !== undefined) button.setAttribute('aria-label', option.description)
        button.onclick = () => {
          const set = this.selected[index]
          if (item.multiSelect) {
            if (set.has(option.label)) set.delete(option.label)
            else set.add(option.label)
          } else {
            set.clear()
            set.add(option.label)
          }
          this.renderContent()
        }
      }

      const customRow = block.createDiv({ cls: 'dsh-question-custom' })
      const input = customRow.createEl('input', {
        cls: 'dsh-question-input',
        attr: { type: 'text', placeholder: '或输入自定义回答…', value: this.custom[index] ?? '' },
      })
      input.oninput = () => { this.custom[index] = input.value }
    }

    const actions = contentEl.createDiv({ cls: 'dsh-question-actions' })
    const submit = actions.createEl('button', { text: '提交回答', cls: 'mod-cta' })
    if (!this.canSubmit()) submit.disabled = true
    submit.onclick = () => { void this.submit() }
    const cancel = actions.createEl('button', { text: '取消' })
    cancel.onclick = () => {
      void this.settle({ ok: false, error: { code: 'cancelled', message: '用户取消了该请求', details: {} } })
    }
  }

  private canSubmit(): boolean {
    return this.question.items.every((item, index) => {
      const hasSelection = (this.selected[index]?.size ?? 0) > 0
      const hasCustom = (this.custom[index] ?? '').trim() !== ''
      return hasSelection || hasCustom
    })
  }

  private async submit(): Promise<void> {
    const answers = this.question.items.map((item, index) => {
      const selected = Array.from(this.selected[index] ?? [])
      const custom = (this.custom[index] ?? '').trim()
      return {
        id: item.id,
        selected,
        ...(custom !== '' ? { custom } : {}),
      }
    })
    await this.settle({ ok: true, value: { answers } })
  }

  private async settle(result: Parameters<DshBridgePlugin['client']['respond']>[1]): Promise<void> {
    if (this.settled) return
    this.settled = true
    await this.plugin.client.respond(this.question.rpcId, result)
    this.close()
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
}


/** Per-chat quick settings: archive mode and agent write approval. */
class ChatSettingsModal extends Modal {
  private readonly plugin: DshBridgePlugin

  constructor(app: App, plugin: DshBridgePlugin) {
    super(app)
    this.plugin = plugin
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h3', { text: '聊天设置' })
    contentEl.createEl('p', {
      text: '以下设置对本插件全局生效；系统提示词由 DSH 主机的 skills 与 system prompt 管理，不在面板内覆盖。',
      cls: 'dsh-modal-hint',
    })

    new Setting(contentEl)
      .setName('会话存档')
      .setDesc('每轮自动追加到 Deepseek Harness/ 存档')
      .addDropdown(dropdown => dropdown
        .addOption('off', '关闭')
        .addOption('turn', '每轮自动追加')
        .addOption('manual', '仅手动')
        .setValue(this.plugin.settings.conversationArchive)
        .onChange(async value => {
          this.plugin.settings.conversationArchive = value as 'off' | 'turn' | 'manual'
          await this.plugin.saveSettings()
        }))

    new Setting(contentEl)
      .setName('写入审批')
      .setDesc('agent 写入/新建笔记前是否弹窗确认')
      .addDropdown(dropdown => dropdown
        .addOption('ask', '询问')
        .addOption('auto', '自动')
        .setValue(this.plugin.settings.writeApproval)
        .onChange(async value => {
          this.plugin.settings.writeApproval = value as 'ask' | 'auto'
          await this.plugin.saveSettings()
        }))
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

interface SessionListEntry {
  sessionId: string
  updatedAt?: number
  running?: boolean
  blank?: boolean
}

/** Restore a past DSH session: pick one from the Host session list. */
class HistoryModal extends Modal {
  private readonly plugin: DshBridgePlugin
  private readonly view: DshChatView

  constructor(app: App, plugin: DshBridgePlugin, view: DshChatView) {
    super(app)
    this.plugin = plugin
    this.view = view
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h3', { text: '历史会话' })
    const list = contentEl.createDiv({ cls: 'dsh-history-list' })
    // Primary view: the user's Obsidian conversations (archive notes).
    this.renderArchived(list)
    // Secondary: the Host's full session list, for power use.
    const toggle = contentEl.createDiv({ cls: 'dsh-history-toggle' })
    const toggleBtn = toggle.createEl('button', { text: '显示全部 DSH 会话', cls: 'dsh-history-toggle-btn' })
    toggleBtn.onclick = () => {
      toggleBtn.disabled = true
      this.renderHostSessions(list)
    }
  }

  /** Archive-backed view: one entry per archived conversation note. */
  private renderArchived(list: HTMLElement): void {
    list.empty()
    list.setText('加载中…')
    void listArchivedConversations(this.app, this.plugin.settings.archiveFolder)
      .then((items) => {
        list.empty()
        if (items.length === 0) {
          list.setText('暂无存档对话（每轮对话会自动存档到 ' + this.plugin.settings.archiveFolder + '/）')
          return
        }
        for (const item of items) {
          const row = list.createDiv({ cls: 'dsh-history-row' })
          const title = row.createDiv({ cls: 'dsh-history-title' })
          title.setText(`${new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false }).slice(0, 16)}  ${item.title}`)
          const tail = row.createDiv({ cls: 'dsh-history-id' })
          tail.setText(item.sessionId.slice(0, 20) + '…')
          row.onclick = () => {
            void this.view.restoreSession(item.sessionId)
            this.close()
          }
        }
      })
      .catch((error) => {
        list.setText(`加载失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** Host session list (secondary view). */
  private renderHostSessions(list: HTMLElement): void {
    list.empty()
    list.setText('加载中…')
    void this.plugin.client.rpc<{ items?: SessionListEntry[] }>('session.list', {})
      .then((value) => {
        list.empty()
        const items = (value.items ?? [])
          .filter(item => item.blank !== true)
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, 30)
        if (items.length === 0) {
          list.setText('暂无历史会话')
          return
        }
        for (const item of items) {
          const row = list.createDiv({ cls: 'dsh-history-row' })
          const when = item.updatedAt !== undefined
            ? new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })
            : '未知时间'
          const title = row.createDiv({ cls: 'dsh-history-title' })
          title.setText(`${item.running === true ? '🟢 ' : ''}${when}`)
          title.setAttribute('aria-label', item.sessionId)
          const tail = row.createDiv({ cls: 'dsh-history-id' })
          tail.setText(item.sessionId.slice(0, 20) + '…')
          row.onclick = () => {
            void this.view.restoreSession(item.sessionId)
            this.close()
          }
        }
      })
      .catch((error) => {
        list.setText(`加载失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  onClose(): void {
    this.contentEl.empty()
  }
}