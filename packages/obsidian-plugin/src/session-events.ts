/**
 * Session event rendering: maps bridge `session/event` frames to display rows.
 * Contract: durable SessionEvent `{ type, seq, time, data }` — the payload
 * always lives in `data`, never on the event root. Mirrors the proven
 * dsh-browser extension logic, trimmed for the Obsidian panel.
 *
 * @module
 */

/** One rendered conversation row. */
export interface Row {
  seq: number
  kind: 'user' | 'assistant' | 'tool' | 'info'
  text: string
  status?: 'running' | 'complete'
}

/** Minimal view of a SessionEvent (payload in `data`). */
export interface SessionEventView {
  type: string
  data?: {
    content?: unknown
    message?: { content?: unknown }
    name?: string
    arguments?: string
    source?: { kind?: string }
  }
}

/** The gateway mux envelope shape carried inside a bridge event frame. */
export interface EventFrameView {
  rpcId: string
  method: string
  payload: unknown
}

/** One pending interaction (ask_user_question waterfall) for a session. */
export interface PendingQuestion {
  rpcId: string
  sessionId: string
  /** Wire id of the first question item; echoed in the answers payload. */
  questionId: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
}

export function pendingQuestionFromFrame(frame: EventFrameView): PendingQuestion | null {
  if (typeof frame.rpcId !== 'string' || frame.method !== 'question/requested' || !isRecord(frame.payload)) return null
  const sessionId = frame.payload.sessionId
  const rawQuestions = frame.payload.questions
  if (typeof sessionId !== 'string' || !Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  // v1 renders a single question per waterfall; batches are answered one by one.
  const first = rawQuestions[0] as Record<string, unknown> | undefined
  if (first === undefined || typeof first.question !== 'string' || typeof first.id !== 'string') return null
  const options: Array<{ label: string; description?: string }> = []
  if (Array.isArray(first.options)) {
    for (const rawOption of first.options) {
      if (typeof rawOption === 'object' && rawOption !== null && typeof (rawOption as { label?: unknown }).label === 'string') {
        options.push({
          label: (rawOption as { label: string }).label,
          ...((rawOption as { description?: unknown }).description !== undefined
            ? { description: (rawOption as { description: string }).description }
            : {}),
        })
      }
    }
  }
  return {
    rpcId: frame.rpcId,
    sessionId,
    questionId: first.id,
    question: first.question,
    ...(typeof first.header === 'string' ? { header: first.header } : {}),
    options,
  }
}

export function resolvedQuestionFromFrame(frame: EventFrameView): { sessionId: string; rpcId: string } | null {
  if (frame.method !== 'question/resolved' || !isRecord(frame.payload)) return null
  const sessionId = frame.payload.sessionId
  const rpcId = frame.payload.questionRpcId
  return typeof sessionId === 'string' && typeof rpcId === 'string' ? { sessionId, rpcId } : null
}

/** Extract model-visible text from content blocks (defensive). */
export function textFromBlocks(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return String(blocks ?? '')
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** Map one session event to a row (user/assistant only; tools handled separately). */
export function rowFromEvent(event: SessionEventView): Row | null {
  switch (event.type) {
    case 'user/message': {
      // dsh logs runtime constant context as user/message with source.kind='plugin'
      // (e.g. <system-reminder> injections) — those are not user messages.
      if (event.data?.source?.kind !== 'user') return null
      const text = textFromBlocks(event.data?.content)
      return text.trim() === '' ? null : { seq: 0, kind: 'user', text }
    }
    case 'assistant/message': {
      const text = textFromBlocks(event.data?.message?.content)
      return text.trim() === '' ? null : { seq: 0, kind: 'assistant', text }
    }
    default:
      return null
  }
}

/** Friendly display name for a tool call. */
export function toolSummary(name: string, argsJson: unknown): string {
  const labels: Record<string, string> = {
    obsidian_list_notes: '列出笔记',
    obsidian_read_note: '读取笔记',
    obsidian_write_note: '写入笔记',
    obsidian_search_vault: '搜索笔记',
    read: '读取文件',
    write: '写入文件',
    bash: '执行命令',
  }
  let summary = labels[name] ?? name
  try {
    const args = JSON.parse(String(argsJson ?? '{}')) as unknown
    if (typeof args === 'object' && args !== null && 'path' in args) {
      const p = String((args as { path?: unknown }).path)
      if (p !== '') summary += `：${p.split('/').pop()}`
    }
  } catch {
    // Unparseable model args: show the tool name only.
  }
  return summary
}

/** live merge: consecutive tool calls collapse into one running row. */
export function appendLiveRow(rows: Row[], kind: Row['kind'], text: string, seq: number): Row[] {
  if (kind === 'tool') {
    const last = rows[rows.length - 1]
    if (last?.kind === 'tool') {
      return [...rows.slice(0, -1), { seq, kind: 'tool', text: `${last.text} → ${text}`, status: 'running' }]
    }
    return [...rows, { seq, kind: 'tool', text, status: 'running' }]
  }
  return [...rows, { seq, kind, text }]
}

/** Mark the last tool row complete (merge, do not add a row). */
export function completeLastTool(rows: Row[], seq: number): Row[] {
  const last = rows[rows.length - 1]
  if (last?.kind === 'tool') {
    return [...rows.slice(0, -1), { ...last, seq, status: 'complete' }]
  }
  return rows
}

/** History render: merge consecutive tool calls into one completed row. */
export function mergeHistoryRows(events: SessionEventView[], nextSeq: () => number): Row[] {
  const rows: Row[] = []
  let pendingTool: { items: string[]; total: number } | null = null
  const flushTool = (): void => {
    if (pendingTool === null) return
    const shown = pendingTool.items.slice(0, 3)
    const label = pendingTool.total > shown.length
      ? `${shown.join(' → ')} 等 ${pendingTool.total} 次`
      : shown.join(' → ')
    rows.push({ seq: nextSeq(), kind: 'tool', text: label, status: 'complete' })
    pendingTool = null
  }
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      const summary = toolSummary(ev.data?.name ?? 'tool', ev.data?.arguments)
      if (pendingTool === null) pendingTool = { items: [summary], total: 1 }
      else {
        pendingTool.items.push(summary)
        pendingTool.total += 1
      }
      continue
    }
    if (ev.type === 'tool/result') continue
    flushTool()
    const row = rowFromEvent(ev)
    if (row !== null) rows.push({ ...row, seq: nextSeq() })
  }
  flushTool()
  return rows
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
