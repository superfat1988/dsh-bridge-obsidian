/**
 * Wire contract between the dsh bridge plugin and the Obsidian client.
 *
 * Zero-dependency module (pure types, constants, and a parser): both the
 * plugin (node) and the Obsidian plugin (Electron renderer) import this file,
 * so the frame shapes can never drift between the two halves.
 *
 * Frames are one JSON object per WebSocket message, discriminated by `t`.
 * Correlation ids (`id`) are minted by the requestor and echoed by the
 * responder; they are opaque strings, never parsed.
 *
 * Frame vocabulary is deliberately aligned with the proven dsh-bridge-browser
 * protocol: the Obsidian chat panel drives sessions through the same
 * `rpc`/`event`/`respond` relay the browser extension uses, and the plugin
 * answers `tool.call` frames exactly like the extension does.
 *
 * @module
 */

/** WebSocket pathname the bridge plugin registers on the host webserver. */
export const BRIDGE_PATH = '/obsidian/bridge'

/** Zero-config discovery endpoint: returns `{ wsUrl }` for the plugin. */
export const BRIDGE_CONFIG_PATH = '/obsidian/bridge-config'

/** Seconds a fresh socket may take to present `hello` before it is closed. */
export const HELLO_TIMEOUT_MS = 5_000

/** Server-side ping cadence; the client answers `pong` to prove liveness. */
export const PING_INTERVAL_MS = 30_000

/** Default bytes of the generated bearer token (256-bit). */
export const DEFAULT_TOKEN_BYTES = 32

/** Default per-tool-call budget (ms). */
export const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default per-read character budget handed to the client in caps. */
export const DEFAULT_MAX_READ_CHARS = 40_000

/** Default vault search result cap handed to the client in caps. */
export const DEFAULT_SEARCH_LIMIT = 20

/** Error codes a tool call may settle with. Open set: consumers must tolerate unknown codes. */
export type ToolErrorCode =
  | 'no-client'
  | 'approval-denied'
  | 'io-error'
  | 'bad-args'
  | 'timeout'
  | 'bridge-closed'
  | 'internal'

/** One tool-call failure: stable machine code plus human text for the model. */
export interface ToolError {
  code: ToolErrorCode
  message: string
}

/** Answer or cancel a pending Host interaction waterfall (permission request). */
export type RespondResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** Capabilities the bridge negotiates in `hello.ok` (vault tool budgets). */
export interface BridgeCaps {
  /** Upper bound on one note read's characters (plugin config). */
  maxReadChars: number
  /** Upper bound on vault search results (plugin config). */
  searchLimit: number
}

/** One vault skill published by the connected Obsidian client. */
export interface VaultSkillEntry {
  /** Skill name from SKILL.md frontmatter (defaults to the folder name). */
  name: string
  /** Trigger description; the model reads the full file only when relevant. */
  description: string
  /** Vault-relative path of the SKILL.md file. */
  path: string
}

/** Frames sent by the Obsidian client to the bridge plugin. */
export type ClientFrame =
  /** First frame, within HELLO_TIMEOUT_MS of socket open. */
  | { t: 'hello'; token: string; vaultName: string }
  /** Unary call projected by the active dsh Host adapter (session.* / workspace.*). */
  | { t: 'rpc'; id: string; method: string; payload: unknown }
  /** Answer or cancel a pending Host interaction waterfall. */
  | { t: 'respond'; id: string; rpcId: string; result: RespondResult }
  /** Result of a previously dispatched tool call. */
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }
  /** Liveness reply. */
  | { t: 'pong' }

/** Frames sent by the bridge plugin to the Obsidian client. */
export type ServerFrame =
  /** Accepted after a valid `hello`. */
  | { t: 'hello.ok'; caps: BridgeCaps }
  /** Reply to an `rpc` frame. */
  | { t: 'rpc.result'; id: string; ok: true; result: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: { code: string; message: string } }
  /** Receipt for a `respond` frame. */
  | { t: 'respond.result'; id: string; ok: true; result: unknown }
  | { t: 'respond.result'; id: string; ok: false; error: { code: string; message: string } }
  /** One bridge-owned event envelope projected from Remote streams and waterfalls. */
  | { t: 'event'; frame: { rpcId: string; method: string; payload: unknown } }
  /** A model-requested vault action to execute in the connected Obsidian client. */
  | { t: 'tool.call'; id: string; name: string; args: Record<string, unknown>; expiresAt: number; sessionId?: string }
  /** Withdraw a tool call that timed out or whose caller was cancelled. */
  | { t: 'tool.cancel'; id: string }
  /** Liveness probe. */
  | { t: 'ping' }
  /** Fatal connection error; the client should re-authenticate. */
  | { t: 'error'; code: string; message: string }

/** Any frame on the wire. */
export type BridgeFrame = ClientFrame | ServerFrame

/**
 * Type guard: is this frame one the SERVER may send? Client-only shapes
 * (hello/tool.result/pong) narrow out, so server-side consumers never
 * dispatch on their own request vocabulary.
 */
export function isServerFrame(frame: BridgeFrame): frame is ServerFrame {
  return frame.t === 'hello.ok'
    || frame.t === 'rpc.result'
    || frame.t === 'respond.result'
    || frame.t === 'event'
    || frame.t === 'tool.call'
    || frame.t === 'tool.cancel'
    || frame.t === 'ping'
    || frame.t === 'error'
}

/**
 * Type guard: is this frame one the CLIENT may send? Server-only shapes
 * narrow out, so client-side consumers never dispatch on server vocabulary.
 */
export function isClientFrame(frame: BridgeFrame): frame is ClientFrame {
  return frame.t === 'hello' || frame.t === 'rpc' || frame.t === 'respond' || frame.t === 'tool.result' || frame.t === 'pong'
}

/**
 * Parse one WebSocket message into a frame.
 * @param text - raw message text.
 * @returns the frame, or `undefined` when the message is not a valid frame.
 */
export function parseBridgeFrame(text: string): BridgeFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const frame = value as Record<string, unknown>
  if (typeof frame.t !== 'string') return undefined
  switch (frame.t) {
    case 'hello':
      return typeof frame.token === 'string'
        && typeof frame.vaultName === 'string'
        ? { t: 'hello', token: frame.token, vaultName: frame.vaultName }
        : undefined
    case 'rpc':
      return typeof frame.id === 'string' && typeof frame.method === 'string'
        ? { t: 'rpc', id: frame.id, method: frame.method, payload: frame.payload }
        : undefined
    case 'respond':
      return typeof frame.id === 'string' && typeof frame.rpcId === 'string' && isRespondResult(frame.result)
        ? { t: 'respond', id: frame.id, rpcId: frame.rpcId, result: frame.result }
        : undefined
    case 'tool.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'tool.result', id: frame.id, ok: true, result: frame.result }
      }
      return isToolError(frame.error)
        ? { t: 'tool.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'skills.manifest':
      return Array.isArray(frame.skills) && frame.skills.every(isSkillEntry)
        ? { t: 'skills.manifest', skills: frame.skills as VaultSkillEntry[] }
        : undefined
    case 'pong':
      return { t: 'pong' }
    case 'hello.ok':
      return isCaps(frame.caps)
        ? { t: 'hello.ok', caps: frame.caps }
        : undefined
    case 'rpc.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'rpc.result', id: frame.id, ok: true, result: frame.result }
      }
      return isWireError(frame.error)
        ? { t: 'rpc.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'respond.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'respond.result', id: frame.id, ok: true, result: frame.result }
      }
      return isWireError(frame.error)
        ? { t: 'respond.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'event':
      return typeof frame.frame === 'object' && frame.frame !== null
        ? { t: 'event', frame: frame.frame as { rpcId: string; method: string; payload: unknown } }
        : undefined
    case 'tool.call':
      if (frame.sessionId !== undefined
        && (typeof frame.sessionId !== 'string' || frame.sessionId.trim() === '')) return undefined
      return typeof frame.id === 'string' && typeof frame.name === 'string'
        && typeof frame.args === 'object' && frame.args !== null && !Array.isArray(frame.args)
        && typeof frame.expiresAt === 'number' && Number.isFinite(frame.expiresAt) && frame.expiresAt > 0
        ? {
            t: 'tool.call',
            id: frame.id,
            name: frame.name,
            args: frame.args as Record<string, unknown>,
            expiresAt: frame.expiresAt,
            ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
          }
        : undefined
    case 'tool.cancel':
      return typeof frame.id === 'string' ? { t: 'tool.cancel', id: frame.id } : undefined
    case 'ping':
      return { t: 'ping' }
    case 'error':
      return typeof frame.code === 'string' && typeof frame.message === 'string'
        ? { t: 'error', code: frame.code, message: frame.message }
        : undefined
    default:
      return undefined
  }
}

function isSkillEntry(value: unknown): value is VaultSkillEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.name === 'string' && entry.name.length > 0
    && typeof entry.description === 'string'
    && typeof entry.path === 'string' && entry.path.length > 0
}

function isCaps(value: unknown): value is BridgeCaps {
  if (typeof value !== 'object' || value === null) return false
  const caps = value as Record<string, unknown>
  return typeof caps.maxReadChars === 'number' && Number.isFinite(caps.maxReadChars) && caps.maxReadChars > 0
    && typeof caps.searchLimit === 'number' && Number.isInteger(caps.searchLimit) && caps.searchLimit > 0
}

function isToolError(value: unknown): value is ToolError {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

function isWireError(value: unknown): value is { code: string; message: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

export function isRespondResult(value: unknown): value is RespondResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  if (result.ok === true) return result.error === undefined
  return result.ok === false && isRespondError(result.error)
}

function isRespondError(value: unknown): value is Extract<RespondResult, { ok: false }>['error'] {
  return isWireError(value)
    && typeof (value as Record<string, unknown>).details === 'object'
    && (value as Record<string, unknown>).details !== null
    && !Array.isArray((value as Record<string, unknown>).details)
}
