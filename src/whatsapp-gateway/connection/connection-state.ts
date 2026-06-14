// PURE: the connection lifecycle state machine (T020a).
//
// This reducer is the single source of truth for "what happens next" on every
// connection event. It exists so the lifecycle that broke the first attempt —
// reconnect handling (C-2) and the intentional-close guard (H-1) — is unit-tested
// here instead of being inlined (and untestable) in the socket-bound gateway.ts.
// `gateway.ts` MUST drive all `connection.update` transitions through this reducer.
import type { ConnectionStatus } from '../types.js';
import { classifyDisconnect } from './disconnect-classifier.js';
import { hasExceededRestartHandshakes, hasExceededRecoverAttempts } from './reconnect-policy.js';

/** What the gateway shell should do after applying an event. */
export type ReconnectAction = 'connected' | 'restart' | 'recover' | 'terminal' | 'none';

/** The reducer's full state — carries the counters and the intentional-close flag. */
export interface ConnectionReducerState {
  status: ConnectionStatus;
  /** Consecutive post-pairing 515 handshakes since the last successful open. */
  restartHandshakes: number;
  /** Consecutive recover reconnect attempts since the last successful open. */
  recoverAttempts: number;
  /** Set by an operator-initiated stop so the resulting close does NOT reconnect (H-1). */
  intentionalClose: boolean;
}

/** Events fed to the reducer, translated from Baileys `connection.update` + operator calls. */
export type ConnectionEvent =
  | { type: 'connecting' }
  | { type: 'open' }
  | { type: 'close'; statusCode: number | undefined }
  | { type: 'intentional-disconnect' };

/** Retry caps the reducer needs (from resolved GatewayConfig). */
export interface ReducerConfig {
  maxRestartHandshakes: number;
  /** `null` ⇒ retry recoverable closes indefinitely. */
  maxRecoverAttempts: number | null;
}

export interface ConnectionReducerResult {
  state: ConnectionReducerState;
  action: ReconnectAction;
}

/** Fresh state for a not-yet-connected gateway. */
export function initialConnectionState(): ConnectionReducerState {
  return {
    status: 'closed',
    restartHandshakes: 0,
    recoverAttempts: 0,
    intentionalClose: false,
  };
}

/**
 * Apply one event to the connection state. Pure: returns a new state + the action the
 * shell should take. Never mutates the input.
 */
export function reduceConnection(
  state: ConnectionReducerState,
  event: ConnectionEvent,
  config: ReducerConfig
): ConnectionReducerResult {
  switch (event.type) {
    case 'connecting':
      return { state: { ...state, status: 'connecting' }, action: 'none' };

    case 'open':
      // A successful open resets every counter and clears the intentional-close flag.
      return {
        state: {
          status: 'connected',
          restartHandshakes: 0,
          recoverAttempts: 0,
          intentionalClose: false,
        },
        action: 'connected',
      };

    case 'intentional-disconnect':
      // Operator asked to stop: mark closed and raise the flag so a trailing close is ignored.
      return {
        state: {
          status: 'closed',
          restartHandshakes: 0,
          recoverAttempts: 0,
          intentionalClose: true,
        },
        action: 'none',
      };

    case 'close': {
      // H-1: a close that follows an operator stop must never schedule a reconnect.
      if (state.intentionalClose) {
        return { state: { ...state, status: 'closed', intentionalClose: false }, action: 'none' };
      }

      const klass = classifyDisconnect(event.statusCode);

      if (klass === 'restart') {
        const restartHandshakes = state.restartHandshakes + 1;
        if (hasExceededRestartHandshakes(restartHandshakes, config.maxRestartHandshakes)) {
          return { state: { ...state, status: 'terminal' }, action: 'terminal' };
        }
        return { state: { ...state, status: 'connecting', restartHandshakes }, action: 'restart' };
      }

      if (klass === 'recover') {
        const recoverAttempts = state.recoverAttempts + 1;
        if (hasExceededRecoverAttempts(recoverAttempts, config.maxRecoverAttempts)) {
          return { state: { ...state, status: 'terminal' }, action: 'terminal' };
        }
        return { state: { ...state, status: 'closed', recoverAttempts }, action: 'recover' };
      }

      // terminal
      return { state: { ...state, status: 'terminal' }, action: 'terminal' };
    }
  }
}
