/**
 * `@yuxianglin/dsh-bridge-obsidian`: token-authenticated WebSocket bridge for
 * the Obsidian plugin plus the text-only `obsidian_*` vault tool set.
 *
 * The bridge mounts its own upgrade route (`/obsidian/bridge`) on the host
 * webserver, OUTSIDE the /api trust fence — so it brings its own bearer-token
 * authentication (first frame `hello` within HELLO_TIMEOUT_MS; no loopback
 * shortcut, the Obsidian client always presents the token). The Obsidian chat
 * panel drives real Host sessions through the Typert Gateway relay
 * (`rpc` frames → `session.*` namespace calls, `$events` projected as `event`
 * frames, question waterfalls answered via `respond`), exactly like the
 * proven dsh-bridge-browser extension path. Tools execute by dispatching
 * `tool.call` frames to the connected Obsidian client, which performs the
 * action against its local vault via the Obsidian Vault API.
 *
 * Opt-in by design: nothing is registered unless this plugin appears in the
 * composition. No dsh core code is touched.
 *
 * @module @yuxianglin/dsh-bridge-obsidian
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { BridgeServer } from './server.ts'
import { registerVaultTools } from './tools.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_MAX_READ_CHARS,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_TOOL_TIMEOUT_MS,
} from './protocol.ts'
import { resolveToken } from './token.ts'
import { createHostApi } from './host-adapter.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bridge-obsidian'

/** Services required by this plugin. */
export const inject = ['webServer', 'typertGateway', 'connection', 'tools']

/** Plugin config: deployment-varying tunables only; the wire contract stays fixed. */
export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). */
  token?: string
  /** Per-tool-call timeout in ms. Defaults to 90000. */
  toolTimeoutMs?: number
  /** Upper bound on one note read's characters. Defaults to 40000. */
  maxReadChars?: number
  /** Upper bound on vault search results. Defaults to 20. */
  searchLimit?: number
}

export const Config: z<Config> = z.object({
  token: z.string(),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  maxReadChars: z.number().step(1).min(500).default(DEFAULT_MAX_READ_CHARS),
  searchLimit: z.number().step(1).min(1).default(DEFAULT_SEARCH_LIMIT),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

/**
 * Apply defaults and direct-call validation at the plugin boundary.
 * @param config - Loader-resolved or directly supplied plugin configuration.
 * @returns a complete configuration ready for runtime use.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    ...(config.token === undefined ? {} : { token: config.token }),
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    maxReadChars: config.maxReadChars ?? DEFAULT_MAX_READ_CHARS,
    searchLimit: config.searchLimit ?? DEFAULT_SEARCH_LIMIT,
  }
  for (const [key, value] of Object.entries(resolved) as Array<[string, number]>) {
    if (key !== 'token' && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`bridge-obsidian: ${key} must be a positive integer`)
    }
  }
  return resolved
}

/**
 * Mount the bridge: resolve the token, register the upgrade route, the tool
 * set, and a system-prompt hint, all effect-scoped for HMR.
 *
 * @param ctx - Cordis context.
 * @param config - plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const tokenRes = await resolveToken(resolved.token)
  const api = createHostApi(ctx)

  const server = new BridgeServer({
    token: tokenRes.token,
    api,
    toolTimeoutMs: resolved.toolTimeoutMs,
    caps: {
      maxReadChars: resolved.maxReadChars,
      searchLimit: resolved.searchLimit,
    },
  })

  const route: WebUpgradeRoute = {
    path: BRIDGE_PATH,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(route), 'bridge-obsidian: /obsidian/bridge upgrade route')
  // 异步 disposer：HMR/卸载时先等桥完全关闭（socket/泵/acceptor 静默）再继续。
  ctx.effect(() => () => server.close(), 'bridge-obsidian: bridge server')

  // Zero-config discovery endpoint: the Obsidian plugin fetches this to learn
  // the bridge WebSocket URL. The URL is derived from the request's Host
  // header so LAN clients get their own reachable address; it carries no
  // secret (the token is always required on the WebSocket itself).
  const configRoute: WebRoute = {
    kind: 'exact',
    path: BRIDGE_CONFIG_PATH,
    handler: (req, res) => {
      const host = typeof req.headers.host === 'string' && req.headers.host.length > 0
        ? req.headers.host
        : `127.0.0.1:${ctx.webServer.port}`
      const wsUrl = `ws://${host}${BRIDGE_PATH}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl }))
    },
  }
  ctx.effect(() => ctx.webServer.register(configRoute), 'bridge-obsidian: /obsidian/bridge-config route')

  ctx.effect(() => {
    const disposers = registerVaultTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      maxReadChars: resolved.maxReadChars,
      searchLimit: resolved.searchLimit,
    })
    return () => { for (const dispose of disposers.values()) dispose() }
  }, 'bridge-obsidian: obsidian vault tools')

  // System-prompt contribution: tell the model the vault bridge exists and
  // how to address notes (vault-relative paths into the CLIENT's vault).
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-obsidian',
      order: 108,
      text: 'An Obsidian vault bridge may be connected. To read, search, list, or edit the user\'s notes, use the obsidian_read_note, '
        + 'obsidian_search_vault, obsidian_list_notes, and obsidian_write_note tools; note paths are vault-relative paths inside the '
        + 'client\'s vault, and writes land in the client\'s local vault (subject to its approval setting). If no Obsidian client is '
        + 'connected, these tools fail — say so instead of guessing note contents.',
    }), 'bridge-obsidian: system prompt section')
  }

  ctx.logger.info(
    tokenRes.generated
      ? `obsidian bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600); paste it into the Obsidian plugin settings`
      : `obsidian bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger.info(`obsidian bridge: listening on ${BRIDGE_PATH}`)
}
