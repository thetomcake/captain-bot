import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

// Timestamp helper for consistent timestamp handling
const timestamp = (name: string) =>
  integer(name, { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`);

// ============================================================================
// TEAMS
// ============================================================================

export const teams = sqliteTable('teams', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  clubUrl: text('club_url').notNull(),
  whatsappGroupId: text('whatsapp_group_id'),
  // MAN v FAT player-portal credentials + session, per team (feature 005). The fixtures page
  // is gated behind a WordPress login; auth lives below the IFixtureScraper boundary.
  manvfatUsername: text('manvfat_username'), // login email, not secret
  manvfatPassword: text('manvfat_password'), // AES-256-GCM encrypted (base64(iv).base64(tag).base64(ct))
  manvfatCookie: text('manvfat_cookie'), // encrypted serialized tough-cookie jar; null until first login
  // Last time an availability poll was posted/replaced for this team (any path). Backs the
  // `!postpoll` 5-minute throttle (T051): chat triggers arriving inside the window are ignored
  // so a member cannot spam-replace the poll. Null until the first poll is posted.
  lastPollPostedAt: integer('last_poll_posted_at', { mode: 'timestamp' }),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

// ============================================================================
// SEASONS
// ============================================================================

export const seasons = sqliteTable(
  'seasons',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    seasonNumber: integer('season_number').notNull(),
    startDate: integer('start_date', { mode: 'timestamp' }),
    endDate: integer('end_date', { mode: 'timestamp' }),
    isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestamp('created_at'),
  },
  (table) => ({
    uniqueTeamSeason: unique().on(table.teamId, table.seasonNumber),
    currentIdx: index('idx_current_season').on(table.teamId, table.isCurrent),
  })
);

// ============================================================================
// GATEWAY CREDENTIALS (opaque WhatsApp session snapshot, FR-008)
// ============================================================================

// Replaces the Baileys-shaped `auth_states` table. The Gateway hands the MVP an
// opaque `WhatsAppCredentials` string via onCredentialsUpdate/getCredentials; we
// persist it verbatim (one row per team — single-operator MVP) and never parse it.
export const gatewayCredentials = sqliteTable('gateway_credentials', {
  teamId: integer('team_id')
    .primaryKey()
    .references(() => teams.id),
  snapshot: text('snapshot').notNull(),
  updatedAt: timestamp('updated_at'),
});

// ============================================================================
// GAMES
// ============================================================================

export const games = sqliteTable(
  'games',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    seasonId: integer('season_id')
      .notNull()
      .references(() => seasons.id),
    gameDate: integer('game_date', { mode: 'timestamp' }).notNull(),
    opponent: text('opponent').notNull(),
    venue: text('venue').notNull(),
    status: text('status').notNull().$type<'upcoming' | 'completed' | 'cancelled'>(),
    scrapedUrl: text('scraped_url'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (table) => ({
    seasonDateIdx: index('idx_game_date').on(table.seasonId, table.gameDate),
    statusIdx: index('idx_game_status').on(table.seasonId, table.status),
  })
);

// ============================================================================
// WHATSAPP USERS
// ============================================================================

export const whatsappUsers = sqliteTable('whatsapp_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Keyed by the Gateway's canonical Identity (FR-013/SC-008): one row per person
  // regardless of address form, so no double-counting across JID/LID/device forms.
  canonicalId: text('canonical_id').notNull().unique(),
  pn: text('pn'), // phone-number form, if known (debug/display)
  lid: text('lid'), // LID form, if known
  displayName: text('display_name'),
  firstSeenAt: timestamp('first_seen_at'),
  lastSeenAt: timestamp('last_seen_at'),
});

// ============================================================================
// POLLS
// ============================================================================

export const polls = sqliteTable(
  'polls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id),
    // The poll-creation message id = keyset `pollId` (a poll IS a message; one id, not two —
    // see data-model.md "Poll identifiers"). Used for keyset lookup and deleteMessage.
    pollMessageId: text('poll_message_id').notNull(),
    // Keyset fields the MVP must persist to decrypt votes after a restart (FR-012/FR-014):
    groupId: text('group_id').notNull(), // the authorized group JID the poll was posted to
    messageSecret: text('message_secret').notNull(), // base64 of the poll's 32-byte secret, verbatim
    postedAt: integer('posted_at', { mode: 'timestamp' }).notNull(),
    pollQuestion: text('poll_question').notNull(),
    pollOptions: text('poll_options', { mode: 'json' }).notNull().$type<string[]>(),
  },
  (table) => ({
    // One poll per game (FR-027): replacement hard-deletes the prior poll before
    // inserting, so this can never legitimately be violated and guards the
    // duplicate-row bug at the DB layer.
    uniqueGame: unique().on(table.gameId),
    gameIdx: index('idx_poll_game').on(table.gameId),
    messageIdx: index('idx_poll_message').on(table.pollMessageId),
  })
);

// ============================================================================
// POLL RESPONSES
// ============================================================================

export const pollResponses = sqliteTable(
  'poll_responses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pollId: integer('poll_id')
      .notNull()
      .references(() => polls.id),
    userId: integer('user_id')
      .notNull()
      .references(() => whatsappUsers.id),
    selectedOption: text('selected_option').notNull(),
    respondedAt: timestamp('responded_at'),
  },
  (table) => ({
    uniqueVote: unique().on(table.pollId, table.userId),
    pollIdx: index('idx_response_poll').on(table.pollId),
  })
);

// ============================================================================
// STAT RECORDS
// ============================================================================

export const statRecords = sqliteTable(
  'stat_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id),
    userId: integer('user_id')
      .notNull()
      .references(() => whatsappUsers.id),
    goals: integer('goals').notNull().default(0),
    assists: integer('assists').notNull().default(0),
    weightDirection: text('weight_direction').$type<'up' | 'down' | 'same' | 'unknown'>(),
    foodTracking: integer('food_tracking', { mode: 'boolean' }),
    confidenceScore: integer('confidence_score').notNull(),
    sourceMessage: text('source_message'),
    capturedAt: timestamp('captured_at'),
    editedAt: integer('edited_at', { mode: 'timestamp' }),
  },
  (table) => ({
    uniqueStat: unique().on(table.gameId, table.userId),
    userIdx: index('idx_stat_user').on(table.userId),
  })
);

// ============================================================================
// DRIZZLE RELATIONS (for query builder)
// ============================================================================

export const teamsRelations = relations(teams, ({ one, many }) => ({
  seasons: many(seasons),
  gatewayCredentials: one(gatewayCredentials, {
    fields: [teams.id],
    references: [gatewayCredentials.teamId],
  }),
}));

export const seasonsRelations = relations(seasons, ({ one, many }) => ({
  team: one(teams, { fields: [seasons.teamId], references: [teams.id] }),
  games: many(games),
}));

export const gatewayCredentialsRelations = relations(gatewayCredentials, ({ one }) => ({
  team: one(teams, { fields: [gatewayCredentials.teamId], references: [teams.id] }),
}));

export const gamesRelations = relations(games, ({ one, many }) => ({
  season: one(seasons, { fields: [games.seasonId], references: [seasons.id] }),
  poll: one(polls, { fields: [games.id], references: [polls.gameId] }),
  statRecords: many(statRecords),
}));

export const whatsappUsersRelations = relations(whatsappUsers, ({ many }) => ({
  pollResponses: many(pollResponses),
  statRecords: many(statRecords),
}));

export const pollsRelations = relations(polls, ({ one, many }) => ({
  game: one(games, { fields: [polls.gameId], references: [games.id] }),
  responses: many(pollResponses),
}));

export const pollResponsesRelations = relations(pollResponses, ({ one }) => ({
  poll: one(polls, { fields: [pollResponses.pollId], references: [polls.id] }),
  user: one(whatsappUsers, {
    fields: [pollResponses.userId],
    references: [whatsappUsers.id],
  }),
}));

export const statRecordsRelations = relations(statRecords, ({ one }) => ({
  game: one(games, { fields: [statRecords.gameId], references: [games.id] }),
  user: one(whatsappUsers, { fields: [statRecords.userId], references: [whatsappUsers.id] }),
}));

// ============================================================================
// TYPE EXPORTS (for use throughout application)
// ============================================================================

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
export type GatewayCredential = typeof gatewayCredentials.$inferSelect;
export type NewGatewayCredential = typeof gatewayCredentials.$inferInsert;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type WhatsAppUser = typeof whatsappUsers.$inferSelect;
export type NewWhatsAppUser = typeof whatsappUsers.$inferInsert;
export type Poll = typeof polls.$inferSelect;
export type NewPoll = typeof polls.$inferInsert;
export type PollResponse = typeof pollResponses.$inferSelect;
export type NewPollResponse = typeof pollResponses.$inferInsert;
export type StatRecord = typeof statRecords.$inferSelect;
export type NewStatRecord = typeof statRecords.$inferInsert;
