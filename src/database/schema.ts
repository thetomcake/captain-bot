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
// AUTH STATES (WhatsApp authentication)
// ============================================================================

export const authStates = sqliteTable(
  'auth_states',
  {
    id: text('id').primaryKey(), // Baileys key ID (e.g., 'creds', 'app-state-sync-key-*')
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    seasonId: integer('season_id')
      .notNull()
      .references(() => seasons.id),
    value: text('value').notNull(), // JSON-serialized with BufferJSON
    updatedAt: timestamp('updated_at'),
  },
  (table) => ({
    authIdx: index('idx_auth_team_season').on(table.teamId, table.seasonId),
  })
);

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
  whatsappId: text('whatsapp_id').notNull().unique(),
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
    whatsappMessageId: text('whatsapp_message_id').notNull(),
    postedAt: integer('posted_at', { mode: 'timestamp' }).notNull(),
    pollQuestion: text('poll_question').notNull(),
    pollOptions: text('poll_options', { mode: 'json' }).notNull().$type<string[]>(),
  },
  (table) => ({
    gameIdx: index('idx_poll_game').on(table.gameId),
    messageIdx: index('idx_poll_message').on(table.whatsappMessageId),
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

export const teamsRelations = relations(teams, ({ many }) => ({
  seasons: many(seasons),
  authStates: many(authStates),
}));

export const seasonsRelations = relations(seasons, ({ one, many }) => ({
  team: one(teams, { fields: [seasons.teamId], references: [teams.id] }),
  games: many(games),
  authStates: many(authStates),
}));

export const authStatesRelations = relations(authStates, ({ one }) => ({
  team: one(teams, { fields: [authStates.teamId], references: [teams.id] }),
  season: one(seasons, { fields: [authStates.seasonId], references: [seasons.id] }),
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
export type AuthState = typeof authStates.$inferSelect;
export type NewAuthState = typeof authStates.$inferInsert;
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
