# Data Model: MAN v FAT Captain Stats Tool

**Feature**: 001-mvf-captain-stats  
**Date**: 2026-06-10  
**Updated**: 2026-06-10 (Added database-based auth, multi-tenant architecture)

## Overview

This document defines the data entities, relationships, validation rules, and state transitions for the Captain Stats tool. The schema is designed for **single-captain MVP** but architected to scale to **multi-captain, multi-team, multi-league** without breaking changes.

**Technology**: Drizzle ORM with better-sqlite3 driver, TypeScript strict mode  
**Storage Strategy**: Database-per-captain (future), single database for MVP  
**Auth Storage**: Database-backed WhatsApp auth state (no Redis required)

---

## Multi-Tenant Architecture (Future)

The schema is designed to support a future use case: **1 captain per team per season per league**.

### Scaling Strategy

**MVP (Current)**:
- Single database: `~/.captain-tom/data.db`
- Single captain (implicit, no captain_id in schema)
- One or more teams managed by this captain

**Future (Multi-Tenant)**:
- Config database: `~/.captain-tom/config.db` (captain registry)
- Database-per-captain: `~/.captain-tom/captains/{captain-id}.db`
- Each captain's database uses identical schema (no breaking changes)
- Auth state scoped by (team, season) within each captain's database

### Migration Path

```typescript
// Zero-downtime migration
// Step 1: Create config.db with captains table
// Step 2: Move data.db → captains/{captain-id}.db
// Step 3: Update connection logic to use getCaptainDb(captainId)
```

See [research.md](./research.md) Section: "Multi-Tenant Architecture" for full implementation details.

---

## Entity Definitions

### Team

Represents a team managed by the captain. Simplified from separate Club+Team entities for MVP clarity.

**Fields**:
- `id` (integer, primary key, auto-increment) - Unique identifier
- `name` (text, required) - Team name or identifier
- `club_url` (text, required) - Club page URL (e.g., `https://manvfatfootball.com/club/watford/`)
- `whatsapp_group_id` (text, nullable) - WhatsApp group JID (e.g., `123456@g.us`), null until authorized
- `created_at` (timestamp) - Record creation time
- `updated_at` (timestamp) - Last update time

**Validation**:
- `name` length: 1-100 characters
- `club_url` must match pattern: `https://manvfatfootball.com/club/*`
- `whatsapp_group_id` must match WhatsApp group JID format if set

**Relationships**:
- Has many Seasons
- Has many AuthStates

**TypeScript Type**:
```typescript
type Team = {
  id: number;
  name: string;
  clubUrl: string;
  whatsappGroupId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

**Notes**:
- MVP: typically one team per captain
- Future: captain may manage multiple teams
- Club information embedded in `club_url` (no separate Club table needed)

**Relationships**:
- Belongs to one Club
- Has many Seasons

**Notes**:
- Team identifier may be derived from club page structure during scraping
- For MVP, single team per club is expected

---

### Season

Represents a competition season for a team.

**Fields**:
- `id` (integer, primary key, auto-increment) - Unique identifier
- `team_id` (integer, foreign key → teams.id, required) - Parent team
- `season_number` (integer, required) - Sequential season number (1, 2, 3...)
- `start_date` (timestamp, nullable) - Season start date (detected from first fixture)
- `end_date` (timestamp, nullable) - Season end date (detected when new season created)
- `is_current` (boolean, default: false) - Is this the current active season?
- `created_at` (timestamp) - Record creation time

**Validation**:
- `season_number` must be positive integer
- Only one season per team can have `is_current = true`
- If both `start_date` and `end_date` are set, `end_date` must be after `start_date`

**Relationships**:
- Belongs to one Team
- Has many Games
- Has many AuthStates (one auth state per season, allowing fresh WhatsApp auth each season)

**Indexes**:
- Unique index on `(team_id, season_number)`
- Index on `(team_id, is_current)` for fast current season lookup

**TypeScript Type**:
```typescript
type Season = {
  id: number;
  teamId: number;
  seasonNumber: number;
  startDate: Date | null;
  endDate: Date | null;
  isCurrent: boolean;
  createdAt: Date;
}
```

**State Transitions**:
1. New season created with `is_current = true` when season transition detected
2. Previous current season updated to `is_current = false`, `end_date` set
3. `start_date` set when first game of season is scraped

**Season Detection Logic**:
- Trigger: All previously scraped fixtures disappear from club website
- When old fixtures gone AND new fixtures appear → create new season
- See [research.md](./research.md) Section: "Season Detection" for algorithm details

**Notes**:
- Season boundaries may be fuzzy; captain can manually create new season via CLI
- Historical seasons never deleted, only marked as not current
- Auth can reset each season (different WhatsApp groups or fresh authentication)

---

### AuthState

**NEW**: Stores WhatsApp authentication state in the database (replaces file-based or Redis auth).

**Fields**:
- `id` (text, primary key) - Baileys auth key ID (e.g., `'creds'`, `'app-state-sync-key-{id}'`, `'pre-key-{id}'`)
- `team_id` (integer, foreign key → teams.id, required) - Team this auth belongs to
- `season_id` (integer, foreign key → seasons.id, required) - Season this auth belongs to
- `value` (text, required) - JSON-serialized auth state (serialized with `BufferJSON.replacer`)
- `updated_at` (timestamp) - Last update time

**Validation**:
- `value` must be valid JSON
- Unique constraint on `(id, team_id, season_id)` - one auth key per team per season

**Relationships**:
- Belongs to one Team
- Belongs to one Season

**Indexes**:
- Unique index on `(id, team_id, season_id)`
- Index on `(team_id, season_id)` for loading all auth keys for a session

**TypeScript Type**:
```typescript
type AuthState = {
  id: string;
  teamId: number;
  seasonId: number;
  value: string; // JSON-serialized
  updatedAt: Date;
}
```

**Business Logic**:
- Auth state scoped by (team, season) NOT (captain, team, season)
- Rationale: Team's WhatsApp group identity persists, but auth can be refreshed per season
- If captain changes between seasons, new captain inherits team's auth OR re-authenticates
- Baileys auth state keys: `creds`, `app-state-sync-key-*`, `pre-key-*`, `sender-key-*`, `session-*`

**Implementation**:
See [research.md](./research.md) Section: "Database-Backed Auth State Implementation" for full code example using Drizzle ORM and Baileys' `BufferJSON` serialization.

---

### Game

Represents a fixture/match for the team.

**Fields**:
- `id` (integer, primary key, auto-increment) - Unique identifier
- `season_id` (integer, foreign key → seasons.id, required) - Parent season
- `game_date` (timestamp, required) - Game date and time
- `opponent` (text, required) - Opponent team name
- `venue` (text, required) - Venue location/name
- `status` (text, required) - Game status enum: `'upcoming'`, `'completed'`, `'cancelled'`
- `scraped_url` (text, nullable) - Source URL from club website (for debugging/change detection)
- `created_at` (timestamp) - Record creation time
- `updated_at` (timestamp) - Last update time

**Validation**:
- `game_date` must be valid timestamp
- `opponent` length: 1-100 characters
- `venue` length: 1-200 characters
- `status` must be one of: `'upcoming'`, `'completed'`, `'cancelled'`

**Relationships**:
- Belongs to one Season
- Has one Poll (optional, posted day after game)
- Has many StatRecords (captured within 3 days post-game)

**Indexes**:
- Index on `(season_id, game_date)` for chronological ordering
- Index on `(season_id, status)` for filtering upcoming/completed games

**TypeScript Type**:
```typescript
type GameStatus = 'upcoming' | 'completed' | 'cancelled';

type Game = {
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
```

**State Transitions**:
1. Created as `'upcoming'` when scraped from fixtures page
2. Manually or automatically marked `'completed'` when game date passes
3. Captain can mark as `'cancelled'` if fixture cancelled
4. Poll posted day after completion (separate Poll entity)
5. Stat capture window: 3 days starting from game completion

**Notes**:
- `scraped_url` helps detect fixture rescheduling (URL change = new fixture data)
- Games can be rescheduled; update `game_date` rather than creating new record
- UK timezone default for all times (configurable)

---

### WhatsAppUser

Represents a player identified by their WhatsApp account.

**Fields**:
- `id` (integer, primary key, auto-increment) - Unique identifier
- `whatsapp_id` (text, required, unique) - WhatsApp JID (e.g., `1234567890@s.whatsapp.net`)
- `display_name` (text, nullable) - Display name from WhatsApp profile or message metadata
- `first_seen_at` (timestamp) - When user first appeared in group
- `last_seen_at` (timestamp) - Last message/interaction timestamp

**Validation**:
- `whatsapp_id` must match format: `*@s.whatsapp.net`
- `display_name` length: 1-100 characters if present

**Relationships**:
- Has many PollResponses
- Has many StatRecords

**Indexes**:
- Unique index on `whatsapp_id`

**TypeScript Type**:
```typescript
type WhatsAppUser = {
  id: number;
  whatsappId: string;
  displayName: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}
```

**Business Logic**:
- Created automatically when user first responds to poll or sends stat message
- `display_name` updated whenever newer WhatsApp message metadata provides it
- Stable across seasons (same player, same WhatsApp ID, multiple seasons of stats)

**Notes**:
- `whatsapp_id` is the stable identifier (JID); display names may change
- Privacy: No health data stored, only weight direction in StatRecords

---

### Poll

Represents an availability poll posted for a specific game.

**Fields**:
- `id` (integer, primary key, auto-increment) - Unique identifier
- `game_id` (integer, foreign key → games.id, required) - Game this poll is for
- `whatsapp_message_id` (text, required) - WhatsApp message ID for vote tracking
- `posted_at` (timestamp, required) - When poll was posted to WhatsApp group
- `poll_question` (text, required) - Poll question text (e.g., "Available for next game vs Red Lions?")
- `poll_options` (text, required) - JSON array of options (e.g., `["Yes", "No", "Maybe"]`)

**Validation**:
- `poll_options` must be valid JSON array
- `poll_options` must have at least 2 choices

**Relationships**:
- Belongs to one Game
- Has many PollResponses

**Indexes**:
- Index on `game_id`
- Index on `whatsapp_message_id` for vote event lookup

**TypeScript Type**:
```typescript
type Poll = {
  id: number;
  gameId: number;
  whatsappMessageId: string;
  postedAt: Date;
  pollQuestion: string;
  pollOptions: string[]; // JSON-decoded
}
```

**Business Logic**:
- Posted automatically day after game completion
- Or posted manually via CLI command
- Baileys poll format with selectable options

---

### PollResponse

Represents a WhatsApp user's answer to a poll.

**Fields**:
- `id` (integer, primary key, auto-increment) - Unique identifier
- `poll_id` (integer, foreign key → polls.id, required) - Poll being answered
- `user_id` (integer, foreign key → whatsapp_users.id, required) - User who responded
- `selected_option` (text, required) - Option selected (must match one of `poll.poll_options`)
- `responded_at` (timestamp) - When response was submitted

**Validation**:
- `selected_option` must exist in parent `poll.poll_options`

**Relationships**:
- Belongs to one Poll
- Belongs to one WhatsAppUser

**Indexes**:
- Unique index on `(poll_id, user_id)` - one vote per user per poll (last vote wins)
- Index on `poll_id` for aggregating responses

**TypeScript Type**:
```typescript
type PollResponse = {
  id: number;
  pollId: number;
  userId: number;
  selectedOption: string;
  respondedAt: Date;
}
```

**Business Logic**:
- If user votes multiple times, update existing record (replace with latest vote)
- Captured from WhatsApp `messages.update` event with `pollUpdates`
- Decrypted using Baileys `getAggregateVotesInPollMessage()`

---

### StatRecord

Represents per-player, per-game statistics.

**Fields**:
- `id` (integer, primary key, auto-increment) - Unique identifier
- `game_id` (integer, foreign key → games.id, required) - Game these stats are for
- `user_id` (integer, foreign key → whatsapp_users.id, required) - Player
- `goals` (integer, default: 0) - Number of goals scored
- `assists` (integer, default: 0) - Number of assists
- `weight_direction` (text, nullable) - Weight change enum: `'up'`, `'down'`, `'same'`, `'unknown'` (null if not mentioned)
- `food_tracking` (boolean, nullable) - Whether player tracked food (null if not mentioned)
- `confidence_score` (integer, required) - NLP parser confidence 0-100 (100 if manual entry)
- `source_message` (text, nullable) - Original WhatsApp message for auditing
- `captured_at` (timestamp) - When stats were captured (auto or manual)
- `edited_at` (timestamp, nullable) - Set when captain manually corrects stats

**Validation**:
- `goals` >= 0
- `assists` >= 0
- `weight_direction` must be one of: `'up'`, `'down'`, `'same'`, `'unknown'`, or null
- `confidence_score` must be 0-100

**Relationships**:
- Belongs to one Game
- Belongs to one WhatsAppUser

**Indexes**:
- Unique index on `(game_id, user_id)` - one stat record per user per game
- Index on `user_id` for player history queries

**TypeScript Type**:
```typescript
type WeightDirection = 'up' | 'down' | 'same' | 'unknown';

type StatRecord = {
  id: number;
  gameId: number;
  userId: number;
  goals: number;
  assists: number;
  weightDirection: WeightDirection | null;
  foodTracking: boolean | null;
  confidenceScore: number;
  sourceMessage: string | null;
  capturedAt: Date;
  editedAt: Date | null;
}
```

**Business Logic**:
- Created during 3-day post-game window when message confidence score >= 70%
- If user sends multiple stat messages for same game, last one wins (update existing record)
- Captain can manually edit any field; `edited_at` timestamp tracks manual corrections
- Defaults when not mentioned: goals=0, assists=0, weightDirection=null, foodTracking=null

**Notes**:
- Privacy: Only weight direction stored (`up`/`down`/`same`/`unknown`), never actual weight values or BMI
- Conservative capture: 70% confidence threshold prevents casual chat misinterpretation
- `source_message` allows captain to audit auto-captured stats

---

## Entity Relationship Diagram

```
Team (1) ──< (many) Season
         ──< (many) AuthState

Season (1) ──< (many) Game
           ──< (many) AuthState

Game (1) ──< (1, optional) Poll
         ──< (many) StatRecord

Poll (1) ──< (many) PollResponse

WhatsAppUser (1) ──< (many) PollResponse
                 ──< (many) StatRecord

AuthState (many-to-one) ──> Team
          (many-to-one) ──> Season
```

**Key Relationships**:
- Team has many Seasons (historical seasons retained)
- Season has many Games
- Auth state scoped by (Team, Season) - allows fresh WhatsApp auth per season
- Game optionally has one Poll (posted day after game)
- Game has many StatRecords (one per player who reported stats)
- WhatsAppUser has many PollResponses and StatRecords (player history across all games)

---

## State Transitions

### Game Status
- `'upcoming'` → `'completed'` (game date passes + stats start being captured)
- `'upcoming'` → `'cancelled'` (manual CLI command if game cancelled)
- `'completed'` → (terminal state)

### Season
- `is_current = true` → `is_current = false` (season detection creates new season)

### Auth State
- New auth created when team first set up
- Can be reset/refreshed at season boundary (QR code re-auth)
- Deleted when captain disconnects team's WhatsApp

---

## Enumerations

### GameStatus (TypeScript)
```typescript
type GameStatus = 'upcoming' | 'completed' | 'cancelled';
```

### WeightDirection (TypeScript)
```typescript
type WeightDirection = 'up' | 'down' | 'same' | 'unknown';
```

**Values**:
- `'up'` - Player's weight increased
- `'down'` - Player's weight decreased  
- `'same'` - Player's weight stayed the same
- `'unknown'` - Not reported or unclear

---

## Data Retention

### Historical Data
- All seasons retained indefinitely (captain's archive)
- Games never deleted (historical record)
- Stats never deleted (historical accuracy)
- Poll responses retained (historical record)
- Auth state can be reset per season (different WhatsApp groups)

### User Data
- WhatsApp users retained even if they leave team (for historical stats attribution)
- No personal health data stored (weight direction only, not actual values)

### Privacy Considerations
- Only data from explicitly authorized WhatsApp group (`whatsapp_group_id` in Team)
- Weight direction only (`'up'`/`'down'`/`'unknown'`), never actual weight values or BMI
- Source messages stored for auditing, but no full message history
- No health data beyond weight direction

---

## Migration Strategy

### MVP Migration (0000_init)
```sql
-- Create all 7 tables with indexes and foreign keys
-- Seed first team and season from .env configuration
-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;
```

### Future Migrations
- Add fields as nullable initially (backward compatibility)
- Create indexes for new query patterns
- Never drop columns with data (use soft deprecation)
- Drizzle migration files: `src/db/migrations/NNNN_description.sql`

### Multi-Tenant Migration (Future)
When scaling to multiple captains:
1. Create `~/.captain-tom/config.db` with captains table
2. Move `data.db` → `captains/{captain-id}.db`
3. Update connection logic to `getCaptainDb(captainId)`
4. No schema changes needed (database-per-captain pattern)

See [research.md](./research.md) Section: "Migration Path: Single-Tenant MVP → Multi-Tenant" for full migration script.

---

## Database Schema (Drizzle ORM)

**File**: `src/db/schema.ts`

```typescript
import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

// Timestamp helper
const timestamp = (name: string) => 
  integer(name, { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`);

// Teams
export const teams = sqliteTable('teams', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  clubUrl: text('club_url').notNull(),
  whatsappGroupId: text('whatsapp_group_id'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

// Seasons
export const seasons = sqliteTable('seasons', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  teamId: integer('team_id').notNull().references(() => teams.id),
  seasonNumber: integer('season_number').notNull(),
  startDate: integer('start_date', { mode: 'timestamp' }),
  endDate: integer('end_date', { mode: 'timestamp' }),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
  createdAt: timestamp('created_at'),
}, (table) => ({
  uniqueTeamSeason: unique().on(table.teamId, table.seasonNumber),
  currentIdx: index('idx_current_season').on(table.teamId, table.isCurrent),
}));

// Auth State (WhatsApp authentication)
export const authStates = sqliteTable('auth_states', {
  id: text('id').primaryKey(), // Baileys key ID
  teamId: integer('team_id').notNull().references(() => teams.id),
  seasonId: integer('season_id').notNull().references(() => seasons.id),
  value: text('value').notNull(), // JSON-serialized with BufferJSON
  updatedAt: timestamp('updated_at'),
}, (table) => ({
  authIdx: index('idx_auth_team_season').on(table.teamId, table.seasonId),
}));

// Games
export const games = sqliteTable('games', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  seasonId: integer('season_id').notNull().references(() => seasons.id),
  gameDate: integer('game_date', { mode: 'timestamp' }).notNull(),
  opponent: text('opponent').notNull(),
  venue: text('venue').notNull(),
  status: text('status').notNull().$type<'upcoming' | 'completed' | 'cancelled'>(),
  scrapedUrl: text('scraped_url'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => ({
  seasonDateIdx: index('idx_game_date').on(table.seasonId, table.gameDate),
  statusIdx: index('idx_game_status').on(table.seasonId, table.status),
}));

// WhatsApp Users
export const whatsappUsers = sqliteTable('whatsapp_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  whatsappId: text('whatsapp_id').notNull().unique(),
  displayName: text('display_name'),
  firstSeenAt: timestamp('first_seen_at'),
  lastSeenAt: timestamp('last_seen_at'),
});

// Polls
export const polls = sqliteTable('polls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameId: integer('game_id').notNull().references(() => games.id),
  whatsappMessageId: text('whatsapp_message_id').notNull(),
  postedAt: integer('posted_at', { mode: 'timestamp' }).notNull(),
  pollQuestion: text('poll_question').notNull(),
  pollOptions: text('poll_options', { mode: 'json' }).notNull().$type<string[]>(),
}, (table) => ({
  gameIdx: index('idx_poll_game').on(table.gameId),
  messageIdx: index('idx_poll_message').on(table.whatsappMessageId),
}));

// Poll Responses
export const pollResponses = sqliteTable('poll_responses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pollId: integer('poll_id').notNull().references(() => polls.id),
  userId: integer('user_id').notNull().references(() => whatsappUsers.id),
  selectedOption: text('selected_option').notNull(),
  respondedAt: timestamp('responded_at'),
}, (table) => ({
  uniqueVote: unique().on(table.pollId, table.userId),
  pollIdx: index('idx_response_poll').on(table.pollId),
}));

// Stat Records
export const statRecords = sqliteTable('stat_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameId: integer('game_id').notNull().references(() => games.id),
  userId: integer('user_id').notNull().references(() => whatsappUsers.id),
  goals: integer('goals').notNull().default(0),
  assists: integer('assists').notNull().default(0),
  weightDirection: text('weight_direction').$type<'up' | 'down' | 'same' | 'unknown'>(),
  foodTracking: integer('food_tracking', { mode: 'boolean' }),
  confidenceScore: integer('confidence_score').notNull(),
  sourceMessage: text('source_message'),
  capturedAt: timestamp('captured_at'),
  editedAt: integer('edited_at', { mode: 'timestamp' }),
}, (table) => ({
  uniqueStat: unique().on(table.gameId, table.userId),
  userIdx: index('idx_stat_user').on(table.userId),
}));

// Drizzle Relations (for query builder)
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
  user: one(whatsappUsers, { fields: [pollResponses.userId], references: [whatsappUsers.id] }),
}));

export const statRecordsRelations = relations(statRecords, ({ one }) => ({
  game: one(games, { fields: [statRecords.gameId], references: [games.id] }),
  user: one(whatsappUsers, { fields: [statRecords.userId], references: [whatsappUsers.id] }),
}));

// Type exports for use throughout application
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
```

---

## Configuration

**Environment Variables** (stored in `.env`, never committed):

```env
# Team Configuration
TEAM_NAME=Watford Tigers
CLUB_URL=https://manvfatfootball.com/club/watford/

# WhatsApp
AUTHORIZED_GROUP_ID=1234567890-1234567890@g.us

# Database
DATABASE_PATH=~/.captain-tom/data.db

# Scheduling
FIXTURE_CHECK_CRON=0 6 * * *  # Daily at 6 AM UK time
TIMEZONE=Europe/London
```

**Validation on Startup**:
- Verify `CLUB_URL` matches `manvfatfootball.com/club/*`
- Verify `AUTHORIZED_GROUP_ID` matches WhatsApp group JID format
- Create database file if not exists
- Run pending Drizzle migrations
- Enable SQLite WAL mode

---

## Summary

This data model supports:
- ✅ Multi-season historical data retention
- ✅ WhatsApp user tracking and attribution
- ✅ Database-backed auth state (no Redis or files needed)
- ✅ Fixture management with status transitions
- ✅ Poll creation and vote aggregation
- ✅ Stat capture with confidence scoring and manual editing
- ✅ Future multi-tenant scaling (database-per-captain)
- ✅ Type-safe queries with strict TypeScript integration
- ✅ Auth state scoped by (team, season) for fresh auth per season

**Next Steps**: See [research.md](./research.md) for implementation details on database-backed auth state and multi-tenant architecture patterns.
