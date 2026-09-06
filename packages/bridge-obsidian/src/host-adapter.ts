/**
 * Host adapter: builds the bridge's `BridgeHostApi` from the running dsh
 * 0.1.3 Host services. The TypertGateway surface used here
 * (`invoke` + `wireStream.open/failure` + `connection.createSharedFetchHandler`)
 * was verified against the 0.1.3 source at
 * packages/api/gateway/src/index.ts and packages/client/connection/src/index.ts.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BridgeHostApi } from './host-api.ts'
import {
  createRemoteHostApi,
  type HostConnectionLike,
  type TypertGatewayLike,
} from './remote-host-api.ts'

/**
 * Build the host API from the cordis context.
 * @param ctx - host context with `typertGateway` and `connection` services.
 * @returns the bridge host API.
 */
export function createHostApi(ctx: Context): BridgeHostApi {
  const gateway = ctx.get('typertGateway') as unknown as TypertGatewayLike | undefined
  const connection = ctx.get('connection') as unknown as HostConnectionLike | undefined
  if (gateway === undefined) throw new Error('bridge-obsidian: dsh typertGateway service is required')
  if (gateway.wireStream === undefined || typeof gateway.invoke !== 'function') {
    throw new Error('bridge-obsidian: dsh typertGateway service is missing invoke/wireStream')
  }
  if (connection === undefined) throw new Error('bridge-obsidian: dsh connection service is required')
  return createRemoteHostApi(gateway, connection)
}
