/**
 * Bridge WebSocket carrier: token-authenticated connection registry, gateway
 * RPC dispatch, per-connection event pump, and tool-call dispatch to the
 * connected Obsidian client.
 *
 * The route this server mounts (`/obsidian/bridge`) lives OUTSIDE the /api
 * trust fence (which only guards the client-connection routes), so the bridge
 * brings its own authentication: a bearer token presented in the `hello`
 * frame within HELLO_TIMEOUT_MS. Unlike the browser bridge there is no
 * loopback shortcut — the Obsidian plugin always presents the token. Host
 * calls terminate at the bridge-owned Host adapter. Methods the /api carrier
 * pins to loopback (`PRIVILEGED_METHODS`) stay loopback-only here regardless
 * of the token, defense in depth for `--host 0.0.0.0` deployments.
 *
 * One active connection at a time: a new authenticated socket replaces the
 * previous one (the old socket is closed and its in-flight tool calls settle
 * as `bridge-closed`).
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { BridgeHostApi } from './host-api.ts'
import {
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  parseBridgeFrame,
  type BridgeCaps,
  type BridgeFrame,
  type ClientFrame,
  type ToolErrorCode,
  type VaultSkillEntry,
} from './protocol.ts'
import { verifyToken } from './token.ts'

/**
 * Gateway methods the /api carrier pins to loopback (mirror of
 * client-connection's PRIVILEGED_METHODS; kept aligned so the two fences
 * cannot drift). The bridge rejects these for non-loopback remotes even with
 * a valid token.
 */
const PRIVILEGED_METHODS = new Set([
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

/** Session mutations whose WebSocket arrival order is behaviorally significant. */
const ORDERED_SESSION_METHODS = new Set([
  'session.prompt',
  'session.cancel',
])

/** Loopback IPv4/IPv6 literals (IPv4-mapped included). Exported for tests and reuse. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Error thrown by requestTool; the tool registry turns it into an isError result. */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** Dependencies the bridge needs from the host. */
export interface BridgeServerDeps {
  /** Bearer token the Obsidian client must present in `hello`. */
  token: string
  /** Active dsh Host adapter used for unary calls, events, and waterfalls. */
  api: BridgeHostApi
  /** Default per-tool-call timeout in ms. */
  toolTimeoutMs: number
  /** Capabilities to echo in `hello.ok` (vault tool budgets). */
  caps: BridgeCaps
  /**
   * Test seam: force the remote address seen by the privilege gate. The
   * sandbox cannot bind arbitrary loopback literals, so the non-loopback
   * branch is exercised through this override; production never sets it.
   */
  remoteAddressOverride?: string
  /** Seconds a fresh socket may present `hello`; defaults to HELLO_TIMEOUT_MS. */
  helloTimeoutMs?: number
  /** Server ping cadence; defaults to PING_INTERVAL_MS. */
  pingIntervalMs?: number
  /** Invoked after a client-driven `session.create` settles with a session id. */
  onSessionCreated?: (sessionId: string) => void
}

/** One in-flight tool call awaiting the client's `tool.result`. */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
}

/** A socket that passed authentication and owns the single active slot. */
interface ReadyConnection {
  ws: WebSocket
  /** Remote address captured at upgrade time (loopback gate for privileged methods). */
  remoteAddress: string | undefined
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
  /** Vault skills manifest published by this client; null until one arrives. */
  skills: VaultSkillEntry[] | null
  /** Vault name presented in `hello`. */
  vaultName: string
}

function sendFrame(ws: WebSocket, frame: BridgeFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/**
 * Decode one ws message payload to text.
 * @param data - ws message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Token-authenticated bridge server. Construct once per plugin instance;
 * dispose with {@link close}.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private current: ReadyConnection | null = null
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  /** Vault name from the latest `hello` (consumed at promotion). */
  private pendingVaultName = 'vault'
  private closed = false

  constructor(private readonly deps: BridgeServerDeps) {}

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param req - upgrade request (carries the client's remote address).
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote) })
  }

  /**
   * Request one vault action from the connected Obsidian client.
   * @param name - tool name (also the wire action name).
   * @param args - validated tool arguments.
   * @param signal - caller cancellation (abort settles the call as cancelled).
   * @param timeoutMs - per-call budget; defaults to the plugin config value.
   * @param sessionId - optional owning Agent session for approval continuity.
   * @returns the client's action result.
   * @throws BridgeToolError when no client is connected, the call times
   *   out, is cancelled, or the client reports a failure.
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
  ): Promise<unknown> {
    const conn = this.current
    if (conn === null) {
      throw new BridgeToolError('no-client', 'no Obsidian client is connected to the bridge')
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the client and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // The client may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        sendFrame(conn.ws, { t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        cancel(new BridgeToolError('bridge-closed', 'tool call cancelled before the client answered'))
      }
      timer = setTimeout(() => {
        cancel(new BridgeToolError('timeout', `vault action "${name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer })
      conn.ws.send(JSON.stringify({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      } satisfies BridgeFrame), (error) => {
        if (error != null) {
          settle(new BridgeToolError('bridge-closed', `bridge socket failed before delivery: ${error.message}`))
        }
      })
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor and all pumps stop.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const pumps = this.current === null ? [] : [this.current.pump]
    this.replaceConnection()
    for (const socket of this.wss.clients) socket.terminate()
    this.current = null
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(pumps)
  }

  /** @returns whether an authenticated Obsidian client is currently connected. */
  hasConnection(): boolean {
    return this.current !== null
  }

  private attach(ws: WebSocket, remoteAddress: string | undefined): void {
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      ws.close(4001, 'hello timeout')
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      const frame = parseBridgeFrame(text)
      if (frame === undefined) {
        ws.close(1008, 'unparseable frame')
        return
      }
      if (helloTimer !== undefined) {
        // Pending state: only `hello` is legal. No loopback shortcut: the
        // Obsidian plugin has a settings field, so the token is always
        // required regardless of where the socket comes from.
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        if (!verifyToken(this.deps.token, frame.token)) {
          ws.close(4002, 'bad token')
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        this.pendingVaultName = frame.vaultName
        this.promote(ws, remoteAddress)
        return
      }
      this.handleReadyFrame(frame)
    }
    const onClose = (): void => {
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (this.current !== null && this.current.ws === ws) this.replaceConnection()
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
  }

  /** Promote an authenticated socket to the single active slot. */
  private promote(ws: WebSocket, remoteAddress: string | undefined): void {
    this.replaceConnection()
    const abort = new AbortController()
    const ping = setInterval(() => { sendFrame(ws, { t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    const pump = (async () => {
      try {
        for await (const frame of this.deps.api.events(abort.signal)) {
          if (ws.readyState !== WebSocket.OPEN) break
          sendFrame(ws, {
            t: 'event',
            frame,
          })
        }
      } catch (error: unknown) {
        if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sendFrame(ws, { t: 'error', code: 'stream-failed', message: String(error) })
          // An authenticated socket without its Remote streams is unusable but
          // otherwise appears healthy to the client. Closing the generation
          // activates its bounded reconnect loop and rebuilds every follower.
          ws.close(1011, 'event stream failed')
        }
      }
    })()
    this.current = { ws, remoteAddress, abort, pump, ping, skills: null, vaultName: this.pendingVaultName }
    sendFrame(ws, { t: 'hello.ok', caps: this.deps.caps })
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
  }

  private handleReadyFrame(frame: BridgeFrame): void {
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(frame)
        break
      case 'respond':
        void this.handleRespond(frame)
        break
      case 'tool.result':
        this.settleTool(frame.id, frame.ok, frame.ok ? frame.result : frame.error)
        break
      case 'skills.manifest':
        if (this.current !== null) this.current.skills = frame.skills
        break
      case 'pong':
      case 'hello':
      case 'hello.ok':
      case 'rpc.result':
      case 'respond.result':
      case 'event':
      case 'tool.call':
      case 'tool.cancel':
      case 'ping':
      case 'error':
        // Protocol violations and unsolicited server-side shapes are ignored;
        // the Obsidian client is the only sender on this channel.
        break
    }
  }

  /**
   * Preserve prompt/cancel arrival order per session. In particular, a cancel
   * racing the admission of its prompt must not reach the host early.
   */
  private routeRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(frame)
      return
    }
    const previous = this.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(frame),
      () => this.handleRpc(frame),
    )
    this.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (this.orderedSessionRpcs.get(sessionId) === task) this.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const conn = this.current
    if (conn === null) return
    const forbidden = PRIVILEGED_METHODS.has(frame.method) && !isLoopbackAddress(conn.remoteAddress)
    if (forbidden) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'forbidden', message: 'method is loopback-only' } })
      return
    }
    try {
      const result = await this.deps.api.call({
        rpcId: frame.id,
        method: frame.method,
        payload: frame.payload,
        signal: conn.abort.signal,
      })
      sendFrame(conn.ws, {
        t: 'rpc.result',
        id: frame.id,
        ok: true,
        result: { type: 'server-response', rpcId: frame.id, result },
      })
      if (frame.method === 'session.create' && result.ok) {
        const sessionId = sessionIdFromValue(result.value)
        if (sessionId !== undefined) this.deps.onSessionCreated?.(sessionId)
      }
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  /** @returns the connected client's vault skills manifest, or null. */
  currentSkills(): VaultSkillEntry[] | null {
    return this.current?.skills ?? null
  }

  /** @returns the connected client's vault name, or null when offline. */
  currentVaultName(): string | null {
    return this.current?.vaultName ?? null
  }

  /** Relay a pending Host waterfall response through the active adapter. */
  private async handleRespond(frame: Extract<ClientFrame, { t: 'respond' }>): Promise<void> {
    const conn = this.current
    if (conn === null) return
    try {
      const result = await this.deps.api.respond(frame.rpcId, frame.result, conn.abort.signal)
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  private settleTool(id: string, ok: boolean, payload: unknown): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new BridgeToolError(payloadCode(payload), payloadMessage(payload)))
  }

  /** Close the current connection (if any) and settle its in-flight calls. */
  private replaceConnection(): void {
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.ping)
    conn.abort.abort()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(4000, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the Obsidian client connection was replaced'))
    }
  }
}

function sessionIdFromValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).sessionId === 'string') {
    return (value as { sessionId: string }).sessionId
  }
  return undefined
}

function orderedSessionId(frame: Extract<ClientFrame, { t: 'rpc' }>): string | undefined {
  if (!ORDERED_SESSION_METHODS.has(frame.method)) return undefined
  if (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload)) return undefined
  const sessionId = (frame.payload as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * Tool error payload → stable code. The wire parser enforces string fields,
 * so the fallback branches are parser-gated.
 * @param payload - client-reported error payload.
 * @returns the stable error code.
 */
export function payloadCode(payload: unknown): ToolErrorCode {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code as ToolErrorCode
    return 'internal'
  }
  return 'internal'
}

/**
 * Tool error payload → message. The wire parser enforces string fields,
 * so the fallback branches are parser-gated.
 * @param payload - client-reported error payload.
 * @returns the human-readable message.
 */
export function payloadMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    return 'vault action failed'
  }
  return 'vault action failed'
}
