/**
 * WhatsApp-specific types for Baileys integration
 */

import type { proto } from '@whiskeysockets/baileys';

/**
 * Simplified WhatsApp message structure
 */
export interface WhatsAppMessage {
  id: string;
  fromMe: boolean;
  remoteJid: string; // Group or user JID
  text: string | null;
  timestamp: Date;
  participant?: string; // Sender JID in group messages
}

/**
 * WhatsApp poll structure
 */
export interface WhatsAppPoll {
  name: string; // Poll question
  values: string[]; // Poll options
  selectableCount: number; // How many options can be selected
}

/**
 * Poll vote aggregation result
 */
export interface PollVoteResult {
  optionName: string;
  voters: string[]; // Array of voter JIDs
  voteCount: number;
}

/**
 * WhatsApp connection state
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'close';

/**
 * WhatsApp event handlers
 */
export interface WhatsAppEventHandlers {
  onMessage?: (message: WhatsAppMessage) => void | Promise<void>;
  onConnectionUpdate?: (state: ConnectionState) => void | Promise<void>;
  onPollVote?: (messageId: string, votes: PollVoteResult[]) => void | Promise<void>;
  onQRCode?: (qr: string) => void;
  onAuthStateUpdate?: () => void | Promise<void>;
}

/**
 * Extracted stat data from message parsing
 */
export interface ExtractedStats {
  goals?: number;
  assists?: number;
  weightDirection?: 'up' | 'down' | 'same' | 'unknown';
  foodTracking?: boolean;
  confidence: number; // 0-100
  rawText: string;
}

/**
 * WhatsApp group info
 */
export interface GroupInfo {
  id: string;
  subject: string; // Group name
  participants: Array<{
    id: string;
    isAdmin: boolean;
  }>;
  description?: string;
}

/**
 * Auth state structure for database storage
 */
export interface AuthStateData {
  creds: object;
  keys: Record<string, object>;
}

/**
 * Message send options
 */
export interface SendMessageOptions {
  quoted?: proto.IWebMessageInfo;
  ephemeralExpiration?: number;
  disappearingMessagesInChat?: boolean;
}

/**
 * Rate limiter state for WhatsApp messaging
 */
export interface RateLimiterState {
  messagesSent: number;
  windowStart: Date;
  maxMessagesPerMinute: number;
}
