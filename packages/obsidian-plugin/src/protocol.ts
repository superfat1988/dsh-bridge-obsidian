/**
 * Wire contract between the dsh bridge plugin and the Obsidian client.
 *
 * CLIENT-SIDE COPY of `packages/bridge-obsidian/src/protocol.ts`. The two
 * files must stay in sync (dsh-bridge-browser keeps one shared module; the
 * Obsidian plugin bundles separately, so the contract is duplicated here and
 * guarded by the repo's sync check).
 *
 * Frames are one JSON object per WebSocket message, discriminated by `t`.
 * Correlation ids (`id`) are minted by the requestor and echoed by the
 * responder; they are opaque strings, never parsed.
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
  maxReadChars: number
  searchLimit: number
}

/** Frames sent by the Obsidian client to the bridge plugin. */
export type ClientFrame =
  | { t: 'hello'; token: string; vaultName: string }
  | { t: 'rpc'; id: string; method: string; payload: unknown }
  | { t: 'respond'; id: string; rpcId: string; result: RespondResult }
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }
  | { t: 'pong' }

/** Frames sent by the bridge plugin to the Obsidian client. */
export type ServerFrame =
  | { t: 'hello.ok'; caps: BridgeCaps }
  | { t: 'rpc.result'; id: string; ok: true; result: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: { code: string; message: string } }
  | { t: 'respond.result'; id: string; ok: true; result: unknown }
  | { t: 'respond.result'; id: string; ok: false; error: { code: string; message: string } }
  | { t: 'event'; frame: { rpcId: string; method: string; payload: unknown } }
  | { t: 'tool.call'; id: string; name: string; args: Record<string, unknown>; expiresAt: number; sessionId?: string }
  | { t: 'tool.cancel'; id: string }
  | { t: 'ping' }
  | { t: 'error'; code: string; message: string }

/** Any frame on the wire. */
export type BridgeFrame = ClientFrame | ServerFrame

/** Parse one WebSocket message into a frame, or undefined when invalid. */
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
      return typeof frame.token === 'string' && typeof frame.vaultName === 'string'
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
    case 'pong':
      return { t: 'pong' }
    case 'hello.ok':
      return isCaps(frame.caps) ? { t: 'hello.ok', caps: frame.caps } : undefined
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
  return result.ok === false && isWireError(result.error)
}
