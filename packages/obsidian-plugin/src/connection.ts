/**
 * BridgeClient: the Obsidian side of the bridge WebSocket.
 *
 * Owns the connection lifecycle (hello handshake, ping/pong, bounded
 * exponential-backoff reconnect with generation invalidation), the rpc
 * promise map, event fan-out, and tool-call dispatch to the executor.
 *
 * @module
 */

import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  HELLO_TIMEOUT_MS,
  parseBridgeFrame,
  type BridgeCaps,
  type RespondResult,
} from './protocol.ts'

/** Fetch the bridge wsUrl from the discovery endpoint; fall back to derivation. */
export async function discoverBridgeUrl(base: string): Promise<string> {
  const trimmed = base.trim().replace(/\/+$/, '')
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed
  try {
    const res = await fetch(`${trimmed}${BRIDGE_CONFIG_PATH}`, { method: 'GET' })
    if (res.ok) {
      const body = (await res.json()) as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.length > 0) return body.wsUrl
    }
  } catch {
    // Discovery unavailable (WAF, offline): derive from the base URL.
  }
  return `${trimmed.replace(/^http/, 'ws')}${BRIDGE_PATH}`
}

export type ConnectionStatus = 'connecting' | 'ready' | 'closed'

export interface ToolCallRequest {
  id: string
  name: string
  args: Record<string, unknown>
  sessionId?: string
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RPC_TIMEOUT_MS = 120_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export class BridgeClient {
  private ws: WebSocket | null = null
  private generation = 0
  private rpcs = new Map<string, PendingRpc>()
  private stopped = true
  private url = ''
  private token = ''
  private vaultName = ''
  private backoff = RECONNECT_MIN_MS

  caps: BridgeCaps = { maxReadChars: 40_000, searchLimit: 20 }

  /** Current session event / question frames (already unwrapped). */
  onEvent: ((frame: { rpcId: string; method: string; payload: unknown }) => void) | null = null
  /** Vault action dispatch; the executor resolves with the tool result. */
  onToolCall: ((call: ToolCallRequest) => Promise<unknown>) | null = null
  onStatus: ((status: ConnectionStatus) => void) | null = null

  /** Start (or restart) the connection loop. Safe to call repeatedly. */
  start(url: string, token: string, vaultName: string): void {
    this.url = url
    this.token = token
    this.vaultName = vaultName
    this.stopped = false
    this.reconnect(0)
  }

  /** Stop the loop and drop the socket; all pending rpcs reject. */
  stop(): void {
    this.stopped = true
    this.generation += 1
    this.ws?.close()
    this.ws = null
    this.failAllPending('connection closed')
    this.onStatus?.('closed')
  }

  /** @returns whether the socket is authenticated and ready. */
  isReady(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * One unary call to the bridge host adapter (session.* / workspace.*).
   * @param method - wire method name, e.g. 'session.create'.
   * @param payload - method payload.
   * @param timeoutMs - per-call budget.
   */
  rpc<T>(method: string, payload: unknown, timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
    const ws = this.ws
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('桥未连接（bridge not connected）'))
    }
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcs.delete(id)
        reject(new Error(`请求超时: ${method}`))
      }, timeoutMs)
      this.rpcs.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ t: 'rpc', id, method, payload }))
    })
  }

  /** Answer a pending host waterfall (permission request). */
  async respond(rpcId: string, result: RespondResult): Promise<void> {
    const ws = this.ws
    if (ws === null || ws.readyState !== WebSocket.OPEN) return
    const id = crypto.randomUUID()
    ws.send(JSON.stringify({ t: 'respond', id, rpcId, result }))
  }

  private reconnect(delayMs: number): void {
    if (this.stopped) return
    const generation = ++this.generation
    this.failAllPending('connection closed')
    this.onStatus?.('connecting')
    setTimeout(() => {
      if (this.stopped || generation !== this.generation) return
      this.open(generation)
    }, delayMs)
  }

  private open(generation: number): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (error) {
      this.scheduleRetry(generation, error instanceof Error ? error.message : String(error))
      return
    }
    this.ws = ws

    const helloTimer = setTimeout(() => {
      if (generation === this.generation && ws.readyState !== WebSocket.OPEN) {
        ws.close()
      }
    }, HELLO_TIMEOUT_MS)

    ws.onopen = () => {
      if (generation !== this.generation) return
      ws.send(JSON.stringify({ t: 'hello', token: this.token, vaultName: this.vaultName }))
    }
    ws.onmessage = (message) => {
      if (generation !== this.generation) return
      this.handleMessage(String(message.data), generation)
    }
    ws.onclose = () => {
      clearTimeout(helloTimer)
      if (generation !== this.generation) return
      this.ws = null
      this.failAllPending('connection closed')
      this.onStatus?.('closed')
      this.scheduleRetry(generation, 'socket closed')
    }
    ws.onerror = () => {
      // close always follows error; nothing to do here.
    }
  }

  private scheduleRetry(generation: number, reason: string): void {
    if (this.stopped || generation !== this.generation) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS)
    setTimeout(() => {
      if (this.stopped || generation !== this.generation) return
      this.reconnect(RECONNECT_MIN_MS)
    }, delay)
    console.warn(`[dsh-bridge] reconnect in ${delay}ms (${reason})`)
  }

  private handleMessage(text: string, generation: number): void {
    const frame = parseBridgeFrame(text)
    if (frame === undefined) return
    switch (frame.t) {
      case 'hello.ok':
        this.backoff = RECONNECT_MIN_MS
        this.caps = frame.caps
        this.onStatus?.('ready')
        break
      case 'ping':
        this.ws?.send(JSON.stringify({ t: 'pong' }))
        break
      case 'rpc.result': {
        const pending = this.rpcs.get(frame.id)
        if (pending === undefined) break
        clearTimeout(pending.timer)
        this.rpcs.delete(frame.id)
        if (frame.ok) pending.resolve(frame.result)
        else pending.reject(new Error(frame.error.message))
        break
      }
      case 'event':
        this.onEvent?.(frame.frame)
        break
      case 'tool.call': {
        const ws = this.ws
        if (ws === null || generation !== this.generation) break
        void this.dispatchTool(ws, frame.id, frame.name, frame.args)
        break
      }
      case 'tool.cancel':
        // The executor observes cancellation via its own timeout budget;
        // a late tool.result for a cancelled call is ignored by the bridge.
        break
      case 'respond.result':
      case 'error':
      case 'rpc':
      case 'respond':
      case 'tool.result':
      case 'hello':
      case 'pong':
        // Unsolicited server-side shapes; ignored.
        break
    }
  }

  private async dispatchTool(ws: WebSocket, id: string, name: string, args: Record<string, unknown>): Promise<void> {
    let resultFrame: { t: 'tool.result'; id: string; ok: true; result: unknown } | { t: 'tool.result'; id: string; ok: false; error: { code: string; message: string } }
    try {
      if (this.onToolCall === null) throw new Error('no executor configured')
      const result = await this.onToolCall({ id, name, args })
      resultFrame = { t: 'tool.result', id, ok: true, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = isToolErrorCode((error as { code?: unknown }).code) ? (error as { code: string }).code : 'internal'
      resultFrame = { t: 'tool.result', id, ok: false, error: { code, message } }
    }
    if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(resultFrame))
    }
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.rpcs) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.rpcs.clear()
  }
}

function isToolErrorCode(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
