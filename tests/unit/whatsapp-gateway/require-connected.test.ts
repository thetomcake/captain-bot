import { describe, it, expect } from 'vitest';
import { requireConnected } from '#src/whatsapp-gateway/connection/require-connected.js';
import type { ConnectionStatus } from '#src/whatsapp-gateway/types.js';

describe('requireConnected (Edge Cases: operations before connection must fail clearly)', () => {
  it('does not throw when status is connected', () => {
    expect(() => requireConnected('connected')).not.toThrow();
  });

  it.each<ConnectionStatus>(['connecting', 'closed', 'terminal'])(
    'throws a clear error when status is %s',
    (status) => {
      expect(() => requireConnected(status)).toThrow(/connect/i);
    }
  );

  it('includes the actual status in the error message', () => {
    expect(() => requireConnected('terminal')).toThrow(/terminal/);
  });
});
