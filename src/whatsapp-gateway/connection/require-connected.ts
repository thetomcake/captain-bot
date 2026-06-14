// Pure guard: throw a clear error unless the gateway is connected.
//
// Operations that require a live socket (send, poll, delete, listGroups) call this
// first so a caller acting before connection fails fast with an actionable message
// instead of a deep Baileys error (Edge Cases; contract Invariants).
import type { ConnectionStatus } from '../types.js';

/**
 * @throws Error if `status !== 'connected'`.
 */
export function requireConnected(status: ConnectionStatus): void {
  if (status !== 'connected') {
    throw new Error(
      `WhatsApp Gateway is not connected (status: "${status}"). Call connect() and await a 'connected' status before performing this operation.`,
    );
  }
}
