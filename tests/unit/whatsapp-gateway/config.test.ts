import { describe, it, expect } from 'vitest';
import { resolveConfig } from '#src/whatsapp-gateway/config.js';
import type { GatewayConfig } from '#src/whatsapp-gateway/types.js';

const GROUP = '120363000000000000@g.us';

describe('resolveConfig (FR-017/FR-018)', () => {
  it('rejects an empty authorizedGroups array', () => {
    expect(() => resolveConfig({ authorizedGroups: [] })).toThrow();
  });

  it('rejects an authorizedGroups entry that is not a group JID', () => {
    // A phone-number user JID is not a group.
    expect(() => resolveConfig({ authorizedGroups: ['12345678901@s.whatsapp.net'] })).toThrow();
    // Garbage is not a group.
    expect(() => resolveConfig({ authorizedGroups: ['not-a-jid'] })).toThrow();
    // A LID user is not a group.
    expect(() => resolveConfig({ authorizedGroups: ['12345@lid'] })).toThrow();
  });

  it('rejects when at least one entry is a non-group JID even if others are valid', () => {
    expect(() =>
      resolveConfig({ authorizedGroups: [GROUP, '12345678901@s.whatsapp.net'] }),
    ).toThrow();
  });

  it('accepts a valid config with one group JID', () => {
    const resolved = resolveConfig({ authorizedGroups: [GROUP] });
    expect(resolved.authorizedGroups).toEqual([GROUP]);
  });

  it('applies documented defaults when optional fields are omitted', () => {
    const resolved = resolveConfig({ authorizedGroups: [GROUP] });
    expect(resolved.minMessageDelayMs).toBe(12000);
    expect(resolved.maxRestartHandshakes).toBe(5);
    expect(resolved.reconnect).toEqual({
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      factor: 2,
      jitter: true,
      maxAttempts: null,
    });
    // A no-op logger is always present so callers never branch on its absence.
    expect(typeof resolved.logger.debug).toBe('function');
    expect(typeof resolved.logger.info).toBe('function');
    expect(typeof resolved.logger.warn).toBe('function');
    expect(typeof resolved.logger.error).toBe('function');
  });

  it('preserves caller-supplied overrides and merges partial reconnect config', () => {
    const config: GatewayConfig = {
      authorizedGroups: [GROUP],
      minMessageDelayMs: 20000,
      maxRestartHandshakes: 3,
      reconnect: { maxDelayMs: 60000 },
    };
    const resolved = resolveConfig(config);
    expect(resolved.minMessageDelayMs).toBe(20000);
    expect(resolved.maxRestartHandshakes).toBe(3);
    // Override applied, other reconnect defaults retained.
    expect(resolved.reconnect.maxDelayMs).toBe(60000);
    expect(resolved.reconnect.baseDelayMs).toBe(1000);
    expect(resolved.reconnect.factor).toBe(2);
  });

  it('carries through the storage-agnostic callbacks untouched', () => {
    const onCredentialsUpdate = (): void => {};
    const resolvePollKeyset = (): null => null;
    const resolved = resolveConfig({
      authorizedGroups: [GROUP],
      credentials: 'opaque-snapshot',
      onCredentialsUpdate,
      resolvePollKeyset,
    });
    expect(resolved.credentials).toBe('opaque-snapshot');
    expect(resolved.onCredentialsUpdate).toBe(onCredentialsUpdate);
    expect(resolved.resolvePollKeyset).toBe(resolvePollKeyset);
  });
});
