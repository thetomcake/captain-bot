// GatewayConfig validation + default resolution (FR-016/FR-017/FR-018).
//
// `resolveConfig` is a pure function: it validates consumer-supplied input that
// TypeScript cannot enforce at runtime (a non-empty authorizedGroups list whose
// every entry is a group JID) and fills in documented defaults so the rest of the
// library can rely on fully-populated values. Unit-tested in config.test.ts.
import { isJidGroup } from '@whiskeysockets/baileys';
import type {
  GatewayConfig,
  Logger,
  ReconnectPolicyConfig,
  WhatsAppCredentials,
  PollRef,
  PollKeyset,
} from './types.js';

/** Fully-resolved config: defaults applied, logger guaranteed present. */
export interface ResolvedGatewayConfig {
  authorizedGroups: string[];
  credentials?: WhatsAppCredentials;
  onCredentialsUpdate?: (creds: WhatsAppCredentials) => void | Promise<void>;
  resolvePollKeyset?: (ref: PollRef) => PollKeyset | null | Promise<PollKeyset | null>;
  minMessageDelayMs: number;
  maxRestartHandshakes: number;
  reconnect: ReconnectPolicyConfig;
  logger: Logger;
}

export const DEFAULT_MIN_MESSAGE_DELAY_MS = 12000; // ≤5 msg/min (FR-016)
export const DEFAULT_MAX_RESTART_HANDSHAKES = 5; // bounds the 515 loop (FR-010)

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicyConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
  jitter: true,
  maxAttempts: null, // retry recoverable closes indefinitely
};

/** A logger that discards everything — used when the consumer supplies none. */
export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Validate a consumer config and resolve defaults.
 *
 * `authorizedGroups` is an inbound-filtering concern (FR-017), not a connection
 * prerequisite, so it is **optional** and defaults to `[]` — auth-only / group-discovery
 * entry points (`connect`, `force-reauth`, `list-groups`) need no group. Any entry that IS
 * supplied must be a group JID (FR-018). Group-dependent operations (inbound dispatch,
 * send, polls) are responsible for failing clearly when the list is empty.
 *
 * @throws Error if `authorizedGroups` contains a non-group JID.
 */
export function resolveConfig(config: GatewayConfig): ResolvedGatewayConfig {
  const authorizedGroups = config.authorizedGroups ?? [];

  if (!Array.isArray(authorizedGroups)) {
    throw new Error(
      'GatewayConfig.authorizedGroups must be an array of group JIDs (…@g.us) (FR-017).'
    );
  }

  for (const jid of authorizedGroups) {
    if (!isJidGroup(jid)) {
      throw new Error(
        `GatewayConfig.authorizedGroups entry "${jid}" is not a group JID (…@g.us) (FR-018).`
      );
    }
  }

  return {
    authorizedGroups: [...authorizedGroups],
    credentials: config.credentials,
    onCredentialsUpdate: config.onCredentialsUpdate,
    resolvePollKeyset: config.resolvePollKeyset,
    minMessageDelayMs: config.minMessageDelayMs ?? DEFAULT_MIN_MESSAGE_DELAY_MS,
    maxRestartHandshakes: config.maxRestartHandshakes ?? DEFAULT_MAX_RESTART_HANDSHAKES,
    reconnect: { ...DEFAULT_RECONNECT_POLICY, ...config.reconnect },
    logger: config.logger ?? NOOP_LOGGER,
  };
}
