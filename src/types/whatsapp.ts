/**
 * WhatsApp-facing types for the MVP.
 *
 * The MVP reaches WhatsApp exclusively through the Gateway port (FR-006/SC-011), so the
 * Baileys-coupled types that used to live here (WhatsAppMessage / WhatsAppPoll /
 * PollVoteResult / ConnectionState, plus the `proto`-dependent SendMessageOptions) are gone.
 * Their Gateway equivalents are re-exported from the port below; only `ExtractedStats` — the
 * pure stat-extractor output, which has no WhatsApp coupling — remains MVP-owned.
 */

// Re-export the Gateway domain types the MVP consumes, via the MVP-owned port (gateway-port.ts),
// so call sites import WhatsApp shapes from one place without reaching into the Gateway directly.
export type {
  ConnectionStatus,
  IncomingMessage,
  MessageRef,
  DeleteOutcome,
  PollSpec,
  PollSendResult,
  PollVote,
  GroupSummary,
  Identity,
  WhatsAppCredentials,
} from '../whatsapp/gateway-port.js';

/**
 * Extracted stat data from message parsing (pure stat-extractor output, US3).
 */
export interface ExtractedStats {
  goals?: number;
  assists?: number;
  weightDirection?: 'up' | 'down' | 'same' | 'unknown';
  foodTracking?: boolean;
  confidence: number; // 0-100
  rawText: string;
}
