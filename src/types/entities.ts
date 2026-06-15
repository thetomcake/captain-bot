/**
 * Core entity types for Captain Stats application
 * These types extend/complement the Drizzle schema types
 */

export type GameStatus = 'upcoming' | 'completed' | 'cancelled';

export type WeightDirection = 'up' | 'down' | 'same' | 'unknown';

/**
 * Team entity - represents a team managed by the captain
 */
export interface Team {
  id: number;
  name: string;
  clubUrl: string;
  whatsappGroupId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Season entity - represents a competition season for a team
 */
export interface Season {
  id: number;
  teamId: number;
  seasonNumber: number;
  startDate: Date | null;
  endDate: Date | null;
  isCurrent: boolean;
  createdAt: Date;
}

/**
 * GatewayCredential entity - opaque WhatsApp session snapshot (FR-008)
 * Replaces the Baileys-shaped AuthState. The snapshot is persisted verbatim and never parsed.
 */
export interface GatewayCredential {
  teamId: number;
  snapshot: string; // opaque WhatsAppCredentials string
  updatedAt: Date;
}

/**
 * Game entity - represents a fixture/match
 */
export interface Game {
  id: number;
  seasonId: number;
  gameDate: Date;
  opponent: string;
  venue: string;
  status: GameStatus;
  scrapedUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * WhatsAppUser entity - represents a player identified by WhatsApp
 */
export interface WhatsAppUser {
  id: number;
  canonicalId: string; // Gateway canonical Identity.canonicalId (one row per person, SC-008)
  pn?: string | null; // phone-number form, if known
  lid?: string | null; // LID form, if known
  displayName: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Poll entity - represents an availability poll for a game
 */
export interface Poll {
  id: number;
  gameId: number;
  pollMessageId: string; // poll-creation message id = keyset pollId (one id, not two)
  groupId: string; // keyset groupId — the authorized group the poll was posted to
  messageSecret: string; // keyset messageSecret (base64, verbatim) — decrypts this poll's votes
  postedAt: Date;
  pollQuestion: string;
  pollOptions: string[]; // JSON-decoded array
}

/**
 * PollResponse entity - represents a user's answer to a poll
 */
export interface PollResponse {
  id: number;
  pollId: number;
  userId: number;
  selectedOption: string;
  respondedAt: Date;
}

/**
 * StatRecord entity - per-player, per-game statistics
 */
export interface StatRecord {
  id: number;
  gameId: number;
  userId: number;
  goals: number;
  assists: number;
  weightDirection: WeightDirection | null;
  foodTracking: boolean | null;
  confidenceScore: number; // 0-100
  sourceMessage: string | null;
  capturedAt: Date;
  editedAt: Date | null;
}

/**
 * Fixture - scraped fixture data (before DB insert)
 */
export interface Fixture {
  date: Date;
  opponent: string;
  venue: string;
  scrapedUrl?: string;
}

/**
 * Enriched game with related data for display
 */
export interface GameWithStats extends Game {
  season: Season;
  stats: StatRecord[];
  poll?: Poll;
}

/**
 * User with aggregated stats
 */
export interface UserWithStats extends WhatsAppUser {
  totalGames: number;
  totalGoals: number;
  totalAssists: number;
}
