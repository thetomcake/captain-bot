import { describe, it, expect } from 'vitest';
import {
  reduceConnection,
  initialConnectionState,
  type ConnectionReducerState,
  type ReducerConfig,
} from '#src/whatsapp-gateway/connection/connection-state.js';

const CONFIG: ReducerConfig = { maxRestartHandshakes: 5, maxRecoverAttempts: null };

// Drive the reducer through a sequence of events, returning the final result.
function run(events: Parameters<typeof reduceConnection>[1][], config: ReducerConfig = CONFIG) {
  let state = initialConnectionState();
  let action = 'none' as ReturnType<typeof reduceConnection>['action'];
  for (const ev of events) {
    ({ state, action } = reduceConnection(state, ev, config));
  }
  return { state, action };
}

describe('reduceConnection — pure connection lifecycle (T020a, C-2/H-1 made testable)', () => {
  it('open → connected and resets the restart/recover counters', () => {
    const start: ConnectionReducerState = {
      status: 'connecting',
      restartHandshakes: 3,
      recoverAttempts: 2,
      intentionalClose: false,
    };
    const { state, action } = reduceConnection(start, { type: 'open' }, CONFIG);
    expect(action).toBe('connected');
    expect(state.status).toBe('connected');
    expect(state.restartHandshakes).toBe(0);
    expect(state.recoverAttempts).toBe(0);
  });

  it('connecting → connecting with no action', () => {
    const { state, action } = reduceConnection(
      initialConnectionState(),
      { type: 'connecting' },
      CONFIG
    );
    expect(action).toBe('none');
    expect(state.status).toBe('connecting');
  });

  it('close:515 → restart, bounded by maxRestartHandshakes; exceeding ⇒ terminal', () => {
    // Five consecutive 515 closes are absorbed as restarts; the sixth exceeds the cap.
    let state = initialConnectionState();
    for (let i = 1; i <= 5; i++) {
      const r = reduceConnection(state, { type: 'close', statusCode: 515 }, CONFIG);
      state = r.state;
      expect(r.action).toBe('restart');
      expect(state.restartHandshakes).toBe(i);
      expect(state.status).toBe('connecting');
    }
    const sixth = reduceConnection(state, { type: 'close', statusCode: 515 }, CONFIG);
    expect(sixth.action).toBe('terminal');
    expect(sixth.state.status).toBe('terminal');
  });

  it('close:recover (408) → recover, schedules a reconnect and counts the attempt', () => {
    const { state, action } = run([{ type: 'open' }, { type: 'close', statusCode: 408 }]);
    expect(action).toBe('recover');
    expect(state.status).toBe('closed');
    expect(state.recoverAttempts).toBe(1);
  });

  it('recover attempts are bounded when maxRecoverAttempts is set; exceeding ⇒ terminal', () => {
    const cfg: ReducerConfig = { maxRestartHandshakes: 5, maxRecoverAttempts: 2 };
    let state = initialConnectionState();
    for (let i = 1; i <= 2; i++) {
      const r = reduceConnection(state, { type: 'close', statusCode: 408 }, cfg);
      state = r.state;
      expect(r.action).toBe('recover');
    }
    const third = reduceConnection(state, { type: 'close', statusCode: 408 }, cfg);
    expect(third.action).toBe('terminal');
    expect(third.state.status).toBe('terminal');
  });

  it('close:terminal (401 loggedOut) → terminal', () => {
    const { state, action } = run([{ type: 'open' }, { type: 'close', statusCode: 401 }]);
    expect(action).toBe('terminal');
    expect(state.status).toBe('terminal');
  });

  it('intentional-disconnect ⇒ closed with no reconnect (H-1 guard)', () => {
    const { state, action } = run([{ type: 'open' }, { type: 'intentional-disconnect' }]);
    expect(action).toBe('none');
    expect(state.status).toBe('closed');
    expect(state.intentionalClose).toBe(true);
  });

  it('a close following an intentional-disconnect does NOT schedule a reconnect (H-1)', () => {
    // Even if Baileys still emits a close after we asked to stop, the flag suppresses reconnection.
    const { action, state } = run([
      { type: 'open' },
      { type: 'intentional-disconnect' },
      { type: 'close', statusCode: 428 },
    ]);
    expect(action).toBe('none');
    expect(state.status).toBe('closed');
  });

  it('reconnecting after an intentional stop clears the flag once a new open succeeds', () => {
    const { state } = run([
      { type: 'open' },
      { type: 'intentional-disconnect' },
      { type: 'connecting' },
      { type: 'open' },
    ]);
    expect(state.status).toBe('connected');
    expect(state.intentionalClose).toBe(false);
  });
});
