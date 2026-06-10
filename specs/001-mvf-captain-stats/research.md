# Research: MAN v FAT Captain Stats Tool

## Overview

This research document consolidates technical investigations for building the Captain Tom stats tracking bot—a WhatsApp-based daemon that scrapes MAN v FAT Football fixtures, collects player stats via casual chat messages, posts polls, and tracks weight/food goals. The research focuses on Node.js/TypeScript patterns for WhatsApp automation, web scraping, database management, NLP extraction, scheduling, and season detection algorithms.

---

## WhatsApp Integration (@whiskeysockets/Baileys)

### Decision

Use **@whiskeysockets/Baileys** as the WhatsApp Web API client with the following configuration:

- **Auth State Storage**: **Database-backed** (SQLite via custom implementation) for MVP; Redis optional for multi-tenant scaling
- **Rate Limiting**: Conservative manual throttling (1 msg/12 seconds = 5 msg/minute)
- **Node.js Version**: 22.x (current release, Baileys compatible)
- **Authentication**: QR code pairing for initial setup
- **Session Persistence**: Stored in `auth_states` table, scoped by (team, season)

### Rationale

- **No browser automation overhead**: Baileys connects directly to WhatsApp's WebSocket protocol, saving ~500MB RAM per instance compared to Puppeteer/Selenium approaches
- **TypeScript native**: Full type definitions without `@types` packages
- **Multi-device support**: Authenticates as secondary device, doesn't interfere with phone usage
- **Event-driven architecture**: Built on Node.js EventEmitter, fits reactive bot patterns
- **Database-backed auth for MVP**: Single storage solution (SQLite), no extra dependencies (no Redis), consistent with rest of architecture
- **Future Redis option**: For multi-tenant production with many concurrent instances, Redis remains an option

### Implementation Patterns

**Basic Connection with Redis Auth**

```typescript
import makeWASocket, {
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { useRedisAuthStateWithHSet } from 'baileys-redis-auth';
import type { RedisOptions } from 'ioredis';

const redisOptions: RedisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
};

const sessionId = 'captain_bot_session';

const { state, saveCreds, redis } = await useRedisAuthStateWithHSet(
  redisOptions,
  sessionId,
  logger
);

const sock = makeWASocket({
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, logger),
  },
  logger,
  printQRInTerminal: true,
  browser: Browsers.ubuntu('CaptainBot'),
  syncFullHistory: false,
  markOnlineOnConnect: false,
});

sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async (update) => {
  const { connection, lastDisconnect } = update;
  
  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    
    if (statusCode === DisconnectReason.loggedOut) {
      const { deleteKeysWithPattern } = await import('baileys-redis-auth');
      await deleteKeysWithPattern({ redis, sessionId, logger });
    }
  }
});
```

**Rate Limiting with baileys-antiban**

```typescript
import { wrapSocket } from 'baileys-antiban';

const safeSock = wrapSocket(sock); // Auto-wraps with rate limiting

// Sending is automatically throttled
await safeSock.sendMessage(groupJid, { text: 'Message' });

// Monitor health
const stats = safeSock.antiban.getStats();
console.log(stats.health.risk); // 'low' | 'medium' | 'high' | 'critical'
```

**Group Message Filtering**

```typescript
const AUTHORIZED_GROUP_ID = process.env.AUTHORIZED_GROUP_ID!;

sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return;
  
  for (const msg of messages) {
    const remoteJid = msg.key.remoteJid!;
    
    // Enforce single group authorization
    if (remoteJid !== AUTHORIZED_GROUP_ID || !remoteJid.endsWith('@g.us')) {
      continue;
    }
    
    const text = msg.message?.conversation || 
                 msg.message?.extendedTextMessage?.text;
    
    if (!text) continue;
    
    // Process authorized group message
    await handleMessage(text, msg);
  }
});
```

**Poll Creation and Vote Tracking**

```typescript
import { getAggregateVotesInPollMessage, proto } from '@whiskeysockets/baileys';

// Store messages for poll decryption
const messageStore = new Map<string, proto.IWebMessageInfo>();

const getMessage = async (key: any) => {
  const storeKey = `${key.remoteJid}:${key.id}`;
  return messageStore.get(storeKey)?.message;
};

// Create poll
await sock.sendMessage(groupJid, {
  poll: {
    name: 'Available for next game?',
    values: ['Yes', 'No', 'Maybe'],
    selectableCount: 1,
  },
});

// Track votes
sock.ev.on('messages.update', async (updates) => {
  for (const { key, update } of updates) {
    if (update.pollUpdates) {
      const pollMessage = await getMessage(key);
      
      if (pollMessage) {
        const votes = getAggregateVotesInPollMessage({
          message: pollMessage,
          pollUpdates: update.pollUpdates,
        });
        
        // votes = [{ name: 'Yes', voters: ['1234@s.whatsapp.net'] }, ...]
        await processPollResults(votes);
      }
    }
  }
});
```

### Alternatives Considered

- **Official WhatsApp Business API**: Requires business verification, paid service, less flexible for casual group bots
- **Puppeteer/Playwright with WhatsApp Web**: 500MB+ RAM overhead per instance, slower message processing
- **Evolution API**: Adds HTTP layer complexity, less control over WebSocket connection

### Testing Strategy

**Unit Tests (Mock Baileys)**

```typescript
import { describe, it, expect, jest } from '@jest/globals';

describe('WhatsApp Message Handler', () => {
  it('should extract stats from message', async () => {
    const mockSock = {
      sendMessage: jest.fn(),
      readMessages: jest.fn(),
    };
    
    const message = {
      key: { remoteJid: 'group@g.us', fromMe: false },
      message: { conversation: 'scored 2 goals' },
    };
    
    await handleMessage(message, mockSock);
    
    expect(mockSock.readMessages).toHaveBeenCalled();
  });
});
```

**Integration Tests (Real Connection)**

- Use separate test WhatsApp group
- QR authentication in CI requires manual intervention (run locally)
- Test message sending, poll creation, group filtering

### References

- [Baileys Documentation](https://baileys.wiki/docs/intro/)
- [baileys-redis-auth GitHub](https://github.com/hbinduni/baileys-redis-auth)
- [baileys-antiban GitHub](https://github.com/kobie3717/baileys-antiban)
- [WhatsApp API Rate Limits Guide](https://www.wasenderapi.com/blog/whatsapp-api-rate-limits-explained-how-to-scale-messaging-safely-in-2025)

---

## Database Layer (Drizzle ORM + SQLite)

### Decision

Use **Drizzle ORM** with **better-sqlite3** driver and the following patterns:

- **Schema**: Single `src/db/schema.ts` file with snake_case columns, camelCase TypeScript
- **Migration Workflow**: `drizzle-kit generate` + `drizzle-kit migrate` for production, `drizzle-kit push` for local dev
- **Auth State**: Redis (separate from application database)
- **Testing**: In-memory SQLite with transaction rollback isolation

### Rationale

- **TypeScript-first**: Strong type inference (`$inferSelect`, `$inferInsert`) without codegen
- **Lightweight**: better-sqlite3 is synchronous, fastest for local SQLite, no external dependencies
- **SQL transparency**: Write SQL-like queries in TypeScript, full control over generated SQL
- **Migration control**: Git-tracked SQL migration files (unlike Prisma's binary migrations)
- **Zero runtime overhead**: No reflection, no schema sync at runtime

### Implementation Patterns

**Schema Definition**

```typescript
import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

export const players = sqliteTable(
  "players",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    whatsappJid: text("whatsapp_jid").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (table) => ({
    jidIdx: uniqueIndex("jid_idx").on(table.whatsappJid),
  })
);

export const gameStats = sqliteTable("game_stats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id")
    .notNull()
    .references(() => players.id, { onDelete: "cascade" }),
  fixtureId: integer("fixture_id")
    .notNull()
    .references(() => fixtures.id),
  goals: integer("goals").default(0),
  assists: integer("assists").default(0),
  confidence: integer("confidence").notNull(), // 0-100
});

export const playersRelations = relations(players, ({ many }) => ({
  stats: many(gameStats),
}));

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
```

**Database Client**

```typescript
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";

const sqlite = new Database(process.env.DATABASE_URL || "./data/app.db");
export const db = drizzle(sqlite, { schema });
```

**Type-Safe Queries**

```typescript
import { eq, and, desc } from "drizzle-orm";

// Insert with type safety
const [player] = await db.insert(players)
  .values({ name: "Tom", whatsappJid: "1234@s.whatsapp.net" })
  .returning();

// Query with relations
const playerWithStats = await db.query.players.findFirst({
  where: eq(players.id, 1),
  with: {
    stats: {
      orderBy: desc(gameStats.id),
      limit: 5,
    },
  },
});

// Complex filtering
const highConfidenceStats = await db.select()
  .from(gameStats)
  .where(
    and(
      eq(gameStats.playerId, 1),
      gte(gameStats.confidence, 70)
    )
  );
```

**Transactions**

```typescript
await db.transaction(async (tx) => {
  const [player] = await tx.insert(players)
    .values({ name: "New Player", whatsappJid: "5678@s.whatsapp.net" })
    .returning();
  
  await tx.insert(gameStats)
    .values({ playerId: player.id, fixtureId: 1, goals: 2 });
  
  // Auto-commits if no error, auto-rollback on exception
});
```

**Migration Configuration**

```typescript
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL || "./data/app.db",
  },
  migrations: {
    prefix: "timestamp",
  },
  strict: true,
  verbose: true,
});
```

### Alternatives Considered

- **Prisma**: Heavier runtime, binary migrations (not Git-friendly), less SQL control
- **TypeORM**: Decorator-based (less TypeScript-idiomatic), slower type inference
- **Kysely**: Similar SQL-first approach, but Drizzle has better relational query API
- **libSQL**: Async-only, future-proofs for Turso migration but adds complexity for local-only use case

### Testing Strategy

**In-Memory SQLite Test Helper**

```typescript
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../src/db/schema";

export function createTestDatabase() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  
  migrate(db, { migrationsFolder: "./drizzle/migrations" });
  
  return { db, sqlite };
}

export function closeTestDatabase(sqlite: Database.Database) {
  sqlite.close();
}
```

**Test Pattern**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Player Repository", () => {
  let db: ReturnType<typeof drizzle>;
  let sqlite: Database.Database;
  
  beforeEach(() => {
    ({ db, sqlite } = createTestDatabase());
  });
  
  afterEach(() => {
    closeTestDatabase(sqlite);
  });
  
  it("should create and retrieve player", async () => {
    const [player] = await db.insert(schema.players)
      .values({ name: "Test Player", whatsappJid: "test@s.whatsapp.net" })
      .returning();
    
    expect(player.id).toBeDefined();
    
    const found = await db.query.players.findFirst({
      where: eq(schema.players.id, player.id),
    });
    
    expect(found).toEqual(player);
  });
});
```

### References

- [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
- [Drizzle Migrations Guide](https://orm.drizzle.team/docs/migrations)
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3)

---

## Web Scraping (Axios + Cheerio vs Playwright)

### Decision

**Start with Axios + Cheerio** for fixture scraping, with fallback to **Playwright** if JavaScript rendering is detected.

**Decision Tree**:
1. Disable JavaScript in browser, reload target fixture page
2. If fixtures visible → Static HTML → Use Axios + Cheerio
3. If fixtures disappear → JavaScript-rendered → Use Playwright

### Rationale

- **Performance**: Axios + Cheerio is 10-50x faster than Playwright for static HTML (sub-100ms vs 2-5s page loads)
- **Resource efficiency**: No browser overhead (~500MB RAM savings per instance)
- **Cost**: Cheaper at scale (fewer CPU cycles, faster execution)
- **Simplicity**: jQuery-style selectors, easier to debug

**Use Playwright when**:
- Fixtures load dynamically via React/Vue/Angular
- "Load More" buttons required for full data
- Network API calls visible (can intercept for faster scraping)

### Implementation Patterns

**Static Scraping (Axios + Cheerio)**

```typescript
import axios from 'axios';
import * as cheerio from 'cheerio';

interface Fixture {
  homeTeam: string;
  awayTeam: string;
  date: string;
  venue?: string;
}

async function scrapeStaticFixtures(url: string): Promise<Fixture[]> {
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CaptainBot/1.0)',
    },
  });
  
  const $ = cheerio.load(data);
  const fixtures: Fixture[] = [];
  
  $('.fixture-row').each((_, element) => {
    fixtures.push({
      homeTeam: $(element).find('.home-team').text().trim(),
      awayTeam: $(element).find('.away-team').text().trim(),
      date: $(element).find('.fixture-date').text().trim(),
      venue: $(element).find('.venue').text().trim(),
    });
  });
  
  return fixtures;
}
```

**Dynamic Scraping (Playwright)**

```typescript
import { chromium } from 'playwright';

async function scrapeDynamicFixtures(url: string): Promise<Fixture[]> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.fixture-item');
  
  const fixtures = await page.$$eval('.fixture-item', (elements) => {
    return elements.map(el => ({
      homeTeam: el.querySelector('.home')?.textContent?.trim() || '',
      awayTeam: el.querySelector('.away')?.textContent?.trim() || '',
      date: el.querySelector('.date')?.textContent?.trim() || '',
    }));
  });
  
  await browser.close();
  return fixtures;
}
```

**Error Handling with Retry**

```typescript
async function fetchWithRetry(
  fetchFn: () => Promise<any>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<any> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetchFn();
    } catch (error: any) {
      const isRetryable = [429, 500, 502, 503, 504].includes(error.response?.status);
      const isLastAttempt = attempt === maxRetries - 1;
      
      if (!isRetryable || isLastAttempt) throw error;
      
      const delay = baseDelay * Math.pow(2, attempt) * (0.5 + Math.random());
      console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

**Rate Limiting**

```typescript
class RateLimiter {
  private queue: (() => Promise<any>)[] = [];
  private running = 0;
  
  constructor(
    private maxConcurrent = 2,
    private minDelay = 2000  // 2 seconds between requests
  ) {}
  
  async add<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.running++;
    try {
      const result = await fn();
      await new Promise(resolve => setTimeout(resolve, this.minDelay));
      return result;
    } finally {
      this.running--;
    }
  }
}

const limiter = new RateLimiter(2, 2000);
const fixtures = await limiter.add(() => scrapeFixtures(url));
```

**Selector Fallback Strategy**

```typescript
function extractTeamName($: cheerio.CheerioAPI, element: cheerio.Element): string {
  const selectors = [
    '.team-name',
    '.fixture__team-name',
    '[data-team]',
    '.team span',
  ];
  
  for (const selector of selectors) {
    const text = $(element).find(selector).text().trim();
    if (text) return text;
  }
  
  throw new Error('Could not extract team name - selectors may have changed');
}
```

### Alternatives Considered

- **Puppeteer**: Similar to Playwright but Chromium-only, less modern API
- **Crawlee**: Full-featured framework with auto-scaling, overkill for single-site scraping
- **Selenium**: Older, slower, more complex setup

### Testing Strategy

**Mock HTML Testing**

```typescript
import nock from 'nock';

describe('Fixture Scraper', () => {
  beforeEach(() => {
    nock('https://manvfat.com')
      .get('/fixtures')
      .reply(200, `
        <div class="fixture-row">
          <span class="home-team">Team A</span>
          <span class="away-team">Team B</span>
          <span class="fixture-date">2026-06-15</span>
        </div>
      `);
  });
  
  it('extracts fixture data correctly', async () => {
    const fixtures = await scrapeStaticFixtures('https://manvfat.com/fixtures');
    
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({
      homeTeam: 'Team A',
      awayTeam: 'Team B',
      date: '2026-06-15',
    });
  });
});
```

**Schema Validation**

```typescript
import { z } from 'zod';

const FixtureSchema = z.object({
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  venue: z.string().optional(),
});

function validateFixtures(data: unknown): Fixture[] {
  return z.array(FixtureSchema).parse(data);
}
```

### References

- [Web Scraping With Node.js in 2026](https://dev.to/vhub_systems_ed5641f65d59/web-scraping-with-nodejs-in-2026-axios-cheerio-playwright-crawlee-4f4g)
- [Best Node.js Web Scrapers 2026](https://www.scrapingbee.com/blog/best-node-js-web-scrapers/)
- [How to Overcome Rate Limiting in Web Scraping](https://www.scrapehero.com/rate-limiting-in-web-scraping/)

---

## NLP Extraction (Pattern Matching + Confidence Scoring)

### Decision

Use **pure TypeScript regex-based pattern matching** with multi-signal confidence scoring (0-100%). No ML libraries.

**Confidence Thresholds**:
- **≥70%**: Auto-accept and log stat
- **50-69%**: Flag for validation or reject based on risk tolerance
- **<50%**: Discard

### Rationale

- **Predictable text structures**: Sports stats messages follow constrained patterns ("scored 2 goals", "got 1 assist")
- **No training data needed**: Pattern matching works immediately without labeled examples
- **Fast execution**: Sub-millisecond performance, no model inference overhead
- **Deterministic**: Same input always produces same output (easier debugging)
- **Low complexity**: No external NLP dependencies to maintain

**When to upgrade to ML**: If message variety exceeds 50+ unique phrasings per stat type, consider NLP.js for intent classification.

### Implementation Patterns

**Pattern Matching with Confidence**

```typescript
interface ExtractionResult {
  type: 'goal' | 'assist' | 'weight' | 'food';
  value: number | string | boolean;
  confidence: number; // 0-100
  rawText: string;
  matchedPattern: string;
}

interface Pattern {
  regex: RegExp;
  baseConfidence: number;
  validator?: (value: any) => boolean;
  uncertaintyMarkers?: string[];
}

class StatsExtractor {
  private patterns = new Map<string, Pattern[]>([
    ['goal', [
      { regex: /scored\s+(\d+)\s+goals?/i, baseConfidence: 95 },
      { regex: /(\d+)\s+goals?/i, baseConfidence: 85 },
      { regex: /got\s+(\d+)/i, baseConfidence: 75, uncertaintyMarkers: ['think', 'maybe'] },
    ]],
    ['assist', [
      { regex: /(\d+)\s+assists?/i, baseConfidence: 90 },
      { regex: /assisted\s+(\d+)/i, baseConfidence: 90 },
    ]],
    ['weight', [
      { regex: /weight\s+(up|down)/i, baseConfidence: 95 },
    ]],
  ]);
  
  private confidenceThreshold = 70;
  
  extract(message: string): ExtractionResult[] {
    const results: ExtractionResult[] = [];
    
    for (const [type, patterns] of this.patterns) {
      for (const pattern of patterns) {
        const match = message.match(pattern.regex);
        if (!match) continue;
        
        let confidence = pattern.baseConfidence;
        
        // Reduce confidence for uncertainty markers
        if (pattern.uncertaintyMarkers) {
          const hasUncertainty = pattern.uncertaintyMarkers.some(
            marker => message.toLowerCase().includes(marker)
          );
          if (hasUncertainty) confidence -= 25;
        }
        
        // Validate value
        const value = this.extractValue(match);
        if (pattern.validator && !pattern.validator(value)) {
          confidence -= 30;
        }
        
        // Range validation
        if (type === 'goal' && (value < 0 || value > 10)) {
          confidence -= 20;
        }
        
        if (confidence >= this.confidenceThreshold) {
          results.push({
            type: type as any,
            value,
            confidence,
            rawText: match[0],
            matchedPattern: pattern.regex.source,
          });
        }
      }
    }
    
    return results;
  }
  
  private extractValue(match: RegExpMatchArray): any {
    return match[1] ? parseInt(match[1]) || match[1] : null;
  }
}
```

**Multi-Signal Confidence Calculation**

```typescript
function calculateConfidence(signals: Record<string, boolean>): number {
  const weights = {
    exactPhraseMatch: 0.40,
    numericContext: 0.30,
    noUncertaintyMarkers: 0.20,
    validRange: 0.10,
  };
  
  let score = 0;
  for (const [key, active] of Object.entries(signals)) {
    if (active && key in weights) {
      score += weights[key as keyof typeof weights];
    }
  }
  
  return Math.round(score * 100);
}
```

**Handling Ambiguity**

```typescript
function detectAmbiguity(message: string): boolean {
  const uncertaintyMarkers = ['think', 'maybe', 'probably', 'might', 'possibly'];
  return uncertaintyMarkers.some(marker => message.toLowerCase().includes(marker));
}

function handleAmbiguousMessage(message: string, extraction: ExtractionResult) {
  if (extraction.confidence < 70) {
    return {
      action: 'REQUEST_CLARIFICATION',
      message: `Did you mean ${extraction.value} ${extraction.type}s? Reply "yes" or provide correct value.`,
    };
  }
  
  return {
    action: 'ACCEPT',
    message: `Logged ${extraction.value} ${extraction.type}(s) with ${extraction.confidence}% confidence.`,
  };
}
```

### Alternatives Considered

- **Compromise.js**: Good for general NLP (260KB), overkill for constrained stats extraction
- **Wink NLP**: TypeScript support, but unnecessary complexity for regex-solvable patterns
- **NLP.js**: Intent classification with confidence, but requires training examples
- **ML models (Transformers)**: Far too heavy for simple extraction (100MB+ model sizes)

### Testing Strategy

**Unit Tests**

```typescript
import { describe, it, expect } from 'vitest';

describe('StatsExtractor', () => {
  const extractor = new StatsExtractor();
  
  it('extracts goals with high confidence from clear messages', () => {
    const results = extractor.extract('scored 3 goals today');
    
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('goal');
    expect(results[0].value).toBe(3);
    expect(results[0].confidence).toBeGreaterThanOrEqual(90);
  });
  
  it('reduces confidence for ambiguous messages', () => {
    const results = extractor.extract('think I got 2');
    
    expect(results[0].confidence).toBeLessThan(70);
  });
  
  it('rejects out-of-range values', () => {
    const results = extractor.extract('scored 99 goals');
    
    expect(results).toHaveLength(0); // Rejected due to low confidence
  });
  
  it('handles multiple stats in one message', () => {
    const results = extractor.extract('scored 2 goals and 1 assist');
    
    expect(results).toHaveLength(2);
    expect(results.find(r => r.type === 'goal')?.value).toBe(2);
    expect(results.find(r => r.type === 'assist')?.value).toBe(1);
  });
});
```

**Property-Based Testing**

```typescript
import fc from 'fast-check';

it('never extracts confidence above 100', () => {
  fc.assert(
    fc.property(fc.string(), (message) => {
      const results = extractor.extract(message);
      return results.every(r => r.confidence <= 100);
    })
  );
});
```

### References

- [6 Best NLP Libraries for Node.js](https://www.kommunicate.io/blog/nlp-libraries-node-javascript/)
- [Confidence Values and Entity Extraction](https://upslopenlp.com/confidence-values-and-entity-extraction/)
- [How to Use Classification Thresholds](https://www.evidentlyai.com/classification-metrics/classification-threshold)

---

## Task Scheduling (Croner)

### Decision

Use **Croner** for all scheduling tasks with the following patterns:

- **Daily tasks**: Cron expressions with `timezone: 'Europe/London'`
- **Event-driven tasks**: Date-based scheduling with database persistence
- **Graceful shutdown**: SIGTERM/SIGINT handlers with job pause and operation tracking

### Rationale

- **Native TypeScript support**: No `@types` packages needed
- **Built-in error handling**: `catch` option prevents silent failures
- **Robust timezone/DST handling**: Uses JavaScript `Intl` API for automatic GMT/BST transitions
- **Active maintenance**: Modern API, better defaults than node-cron/node-schedule
- **Safer production**: node-cron/node-schedule require manual try-catch blocks, have DST edge cases

### Implementation Patterns

**Daily Recurring Task**

```typescript
import { Cron } from 'croner';

const fixtureCheckJob = new Cron(
  '0 6 * * *', // 6 AM daily
  {
    timezone: 'Europe/London',
    name: 'daily-fixture-check',
    catch: (error) => {
      console.error('Fixture check failed:', error);
      // Log to database or monitoring system
    },
  },
  async () => {
    console.log('Running daily fixture check...');
    await checkFixtures();
  }
);
```

**Event-Driven Scheduling (Post-Game Poll)**

```typescript
import { EventEmitter } from 'events';

class GameScheduler extends EventEmitter {
  private scheduledPolls = new Map<string, Cron>();
  
  constructor() {
    super();
    this.on('game-completed', (gameId, completedAt) => {
      this.schedulePostGamePoll(gameId, completedAt);
    });
  }
  
  private schedulePostGamePoll(gameId: string, completedAt: Date) {
    const pollTime = new Date(completedAt.getTime() + 60 * 60 * 1000); // 1 hour later
    
    const pollJob = new Cron(
      pollTime,
      {
        timezone: 'Europe/London',
        name: `poll-${gameId}`,
        catch: (error) => console.error(`Poll failed for ${gameId}:`, error),
      },
      async () => {
        await this.postPollToWhatsApp(gameId);
        pollJob.stop();
        this.scheduledPolls.delete(gameId);
      }
    );
    
    this.scheduledPolls.set(gameId, pollJob);
  }
  
  public markGameComplete(gameId: string) {
    this.emit('game-completed', gameId, new Date());
  }
}
```

**Persistent Scheduling (Database-Backed)**

```typescript
import { db } from './database/client';
import { scheduledTasks } from './database/schema';

class PersistentScheduler {
  private jobs = new Map<string, Cron>();
  
  async initialize() {
    const pendingTasks = await db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.status, 'pending'));
    
    for (const task of pendingTasks) {
      await this.restoreTask(task);
    }
  }
  
  private async restoreTask(task: any) {
    const now = new Date();
    
    if (task.scheduledFor < now) {
      await this.markTaskMissed(task.id);
      return;
    }
    
    const job = new Cron(
      task.scheduledFor,
      {
        timezone: 'Europe/London',
        name: task.id,
        catch: async (error) => await this.markTaskFailed(task.id, error),
      },
      async () => {
        await this.executeTask(task);
        await this.markTaskCompleted(task.id);
        job.stop();
        this.jobs.delete(task.id);
      }
    );
    
    this.jobs.set(task.id, job);
  }
  
  async scheduleEventTask(gameId: string, scheduledFor: Date) {
    const taskId = `poll-${gameId}`;
    await db.insert(scheduledTasks).values({
      id: taskId,
      type: 'event-driven',
      gameId,
      scheduledFor,
      status: 'pending',
    });
    
    await this.restoreTask({ id: taskId, scheduledFor, status: 'pending' });
  }
}
```

**Graceful Shutdown**

```typescript
class DaemonManager {
  private jobs: Cron[] = [];
  private activeOperations = 0;
  private isShuttingDown = false;
  
  registerJob(job: Cron) {
    this.jobs.push(job);
  }
  
  async gracefulShutdown(signal: string) {
    if (this.isShuttingDown) return;
    console.log(`Received ${signal}, starting graceful shutdown...`);
    this.isShuttingDown = true;
    
    // Stop accepting new executions
    this.jobs.forEach(job => job.pause());
    
    // Wait for active operations (with 10s timeout)
    try {
      await Promise.race([
        this.waitForActiveOperations(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Shutdown timeout')), 10000)
        ),
      ]);
    } catch (error) {
      console.error('Forced shutdown due to timeout');
    }
    
    this.jobs.forEach(job => job.stop());
    await this.closeDatabase();
    await this.closeWhatsApp();
    
    process.exit(0);
  }
  
  private async waitForActiveOperations() {
    while (this.activeOperations > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  trackOperation(operation: () => Promise<void>) {
    if (this.isShuttingDown) throw new Error('Server is shutting down');
    this.activeOperations++;
    return operation().finally(() => this.activeOperations--);
  }
}

const daemonManager = new DaemonManager();
process.on('SIGTERM', () => daemonManager.gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => daemonManager.gracefulShutdown('SIGINT'));
```

### Alternatives Considered

- **node-cron**: Popular (3M downloads/week) but requires manual error handling, no TypeScript types
- **node-schedule**: Similar issues, historically had DST bugs
- **Bull/BullMQ**: Redis-based job queue, overkill for simple time-based scheduling

### Testing Strategy

**Fake Timers (Vitest)**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('PollScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  
  afterEach(() => {
    vi.useRealTimers();
  });
  
  it('should schedule poll 1 hour after game end', async () => {
    const mockPollService = { postPoll: vi.fn() };
    const scheduler = new PollScheduler(mockPollService);
    
    const gameEndTime = new Date('2026-06-10T20:00:00Z');
    scheduler.schedulePostGamePoll('game-123', gameEndTime);
    
    vi.advanceTimersByTime(60 * 60 * 1000);
    
    expect(mockPollService.postPoll).toHaveBeenCalledWith('game-123');
  });
});
```

**Manual Callback Execution**

```typescript
describe('Manual Scheduler Tests', () => {
  it('should execute callback directly', async () => {
    const callback = vi.fn();
    
    await callback();
    
    expect(callback).toHaveBeenCalled();
  });
});
```

### References

- [Croner Documentation](https://croner.56k.guru/)
- [node-cron vs node-schedule vs Croner](https://www.pkgpulse.com/blog/node-cron-vs-node-schedule-vs-croner-task-scheduling-nodejs-2026)
- [Node.js Graceful Shutdown Guide](https://1xapi.com/blog/nodejs-api-graceful-shutdown-sigterm-kubernetes-2026)

---

## Season Transition Detection

### Decision

Implement **multi-signal detection algorithm** with database-backed state tracking:

**Detection Signals**:
1. **Mass disappearance** (≥80% fixtures gone)
2. **New season patterns** (matchweek 1, early rounds)
3. **Temporal gap** (14-60 day gap between old/new fixtures)
4. **Fixture ID reset** (IDs restart at lower values)
5. **Date range reset** (year change or seasonal reset)

**Confidence Threshold**: 65% weighted score required to trigger season transition.

### Rationale

- **Robust detection**: Multiple independent signals reduce false positives from website changes
- **Explainable**: Each signal contributes weighted score, making decisions auditable
- **Flexible**: Can tune weights and thresholds based on real-world observations
- **State persistence**: Database stores scrape history for retrospective analysis

### Implementation Patterns

**Core Detection Algorithm**

```typescript
interface SeasonTransition {
  detected: boolean;
  confidence: number;
  signals: Record<string, boolean>;
  timestamp: Date;
  triggeringFactors: string[];
}

function detectSeasonTransition(
  currentFixtures: Fixture[],
  previousFixtures: Fixture[]
): SeasonTransition {
  const disappearedFixtures = previousFixtures.filter(
    prev => !currentFixtures.some(curr => curr.id === prev.id)
  );
  
  const disappearanceRatio = disappearedFixtures.length / previousFixtures.length;
  
  const signals = {
    massDisappearance: disappearanceRatio >= 0.80,
    newSeasonPattern: hasNewSeasonCharacteristics(currentFixtures),
    temporalGap: detectTemporalGap(currentFixtures, previousFixtures),
    fixtureIdReset: detectIdSequenceReset(currentFixtures, previousFixtures),
    dateRangeReset: detectDateRangeReset(currentFixtures, previousFixtures),
  };
  
  const confidence = calculateConfidence(signals);
  
  return {
    detected: confidence >= 0.65,
    confidence,
    signals,
    timestamp: new Date(),
    triggeringFactors: Object.keys(signals).filter(key => signals[key as keyof typeof signals]),
  };
}

function hasNewSeasonCharacteristics(fixtures: Fixture[]): boolean {
  const hasEarlyRounds = fixtures.some(f => f.matchweek <= 2);
  const hasSeasonMarkers = fixtures.some(f => 
    f.description?.match(/week 1|round 1|season start/i)
  );
  const hasResetMatchweeks = Math.min(...fixtures.map(f => f.matchweek)) === 1;
  
  return hasEarlyRounds || hasSeasonMarkers || hasResetMatchweeks;
}

function detectTemporalGap(current: Fixture[], previous: Fixture[]): boolean {
  if (!previous.length || !current.length) return false;
  
  const mostRecentPrevious = new Date(Math.max(...previous.map(f => f.date.getTime())));
  const earliestCurrent = new Date(Math.min(...current.map(f => f.date.getTime())));
  
  const gapDays = (earliestCurrent.getTime() - mostRecentPrevious.getTime()) / (1000 * 60 * 60 * 24);
  
  return gapDays >= 14 && gapDays <= 60;
}

function calculateConfidence(signals: Record<string, boolean>): number {
  const weights = {
    massDisappearance: 0.40,
    newSeasonPattern: 0.25,
    temporalGap: 0.15,
    fixtureIdReset: 0.10,
    dateRangeReset: 0.10,
  };
  
  let score = 0;
  for (const [key, active] of Object.entries(signals)) {
    if (active && key in weights) {
      score += weights[key as keyof typeof weights];
    }
  }
  
  return score;
}
```

**Season Data Migration**

```typescript
async function onSeasonTransitionDetected(
  transitionEvent: SeasonTransition,
  previousFixtures: Fixture[],
  currentFixtures: Fixture[]
) {
  // 1. Archive current season
  const archiveSeason = {
    seasonId: generateSeasonId(previousFixtures),
    startDate: new Date(Math.min(...previousFixtures.map(f => f.date.getTime()))),
    endDate: new Date(Math.max(...previousFixtures.map(f => f.date.getTime()))),
    totalFixtures: previousFixtures.length,
    archivedAt: new Date(),
    confidence: transitionEvent.confidence,
  };
  
  await db.insert(seasons).values(archiveSeason);
  
  // 2. Move fixtures to archive
  for (const fixture of previousFixtures) {
    await db.update(fixtures)
      .set({ seasonId: archiveSeason.seasonId, archived: true })
      .where(eq(fixtures.id, fixture.id));
  }
  
  // 3. Create new season
  const newSeason = {
    seasonId: generateSeasonId(currentFixtures),
    startDate: new Date(Math.min(...currentFixtures.map(f => f.date.getTime()))),
    status: 'ACTIVE',
    createdAt: new Date(),
  };
  
  await db.insert(seasons).values(newSeason);
  
  // 4. Link current fixtures to new season
  for (const fixture of currentFixtures) {
    await db.update(fixtures)
      .set({ seasonId: newSeason.seasonId })
      .where(eq(fixtures.id, fixture.id));
  }
  
  // 5. Rollover player stats
  await rolloverPlayerStats(archiveSeason.seasonId, newSeason.seasonId);
}

function generateSeasonId(fixtures: Fixture[]): string {
  const earliestDate = new Date(Math.min(...fixtures.map(f => f.date.getTime())));
  const year = earliestDate.getFullYear();
  const quarter = Math.floor((earliestDate.getMonth() / 3)) + 1;
  return `${year}-Q${quarter}`;
}

async function rolloverPlayerStats(oldSeasonId: string, newSeasonId: string) {
  const players = await db.query.players.findMany({
    with: { stats: true },
  });
  
  for (const player of players) {
    const finalStats = player.stats.filter(s => s.seasonId === oldSeasonId);
    
    // Archive to historical table
    await db.insert(playerSeasonHistory).values({
      playerId: player.id,
      seasonId: oldSeasonId,
      gamesPlayed: finalStats.reduce((sum, s) => sum + s.gamesPlayed, 0),
      goals: finalStats.reduce((sum, s) => sum + s.goals, 0),
    });
    
    // Reset current season stats
    await db.insert(playerStats).values({
      playerId: player.id,
      seasonId: newSeasonId,
      gamesPlayed: 0,
      goals: 0,
    });
  }
}
```

**Edge Case Handling**

```typescript
function detectAnomalousChanges(prev: Fixture[], curr: Fixture[]): AnomalyType {
  const structuralChanges = {
    fixtureCountDrop: curr.length < prev.length * 0.3,
    completeReplacement: prev.filter(p => curr.some(c => c.id === p.id)).length === 0,
    fragmentedData: hasInconsistentStructure(curr),
  };
  
  // Website change, not season transition
  if (structuralChanges.fragmentedData && !structuralChanges.completeReplacement) {
    return AnomalyType.WEBSITE_CHANGE;
  }
  
  // Season transition
  if (structuralChanges.completeReplacement && hasNewSeasonCharacteristics(curr)) {
    return AnomalyType.SEASON_TRANSITION;
  }
  
  // Data loss
  if (structuralChanges.fixtureCountDrop && !structuralChanges.completeReplacement) {
    return AnomalyType.DATA_LOSS;
  }
  
  return AnomalyType.NORMAL_UPDATE;
}
```

**Database Schema**

```typescript
export const seasons = sqliteTable('seasons', {
  seasonId: text('season_id').primaryKey(),
  startDate: integer('start_date', { mode: 'timestamp' }).notNull(),
  endDate: integer('end_date', { mode: 'timestamp' }),
  status: text('status').notNull(), // 'ACTIVE' | 'COMPLETED' | 'ARCHIVED'
  totalFixtures: integer('total_fixtures'),
  confidence: integer('confidence'), // 0-100
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
});

export const scrapeHistory = sqliteTable('scrape_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scrapedAt: integer('scraped_at', { mode: 'timestamp' }).notNull(),
  fixturesFound: integer('fixtures_found').notNull(),
  fixturesDisappeared: integer('fixtures_disappeared').notNull(),
  seasonTransitionDetected: integer('season_transition_detected', { mode: 'boolean' }).default(false),
  transitionConfidence: integer('transition_confidence'),
  anomalyType: text('anomaly_type'), // 'NONE' | 'WEBSITE_CHANGE' | 'DATA_LOSS'
});
```

### Alternatives Considered

- **Manual season markers**: Require admin to manually mark season transitions (error-prone)
- **Single-signal detection**: Only use fixture disappearance (high false positive rate)
- **ML-based changepoint detection**: Overkill for predictable seasonal patterns

### Testing Strategy

```typescript
describe('Season Transition Detection', () => {
  it('detects normal season transition', () => {
    const oldSeason = generateMockFixtures({
      count: 28,
      dateRange: ['2026-01-01', '2026-03-31'],
      matchweeks: [1, 14],
    });
    
    const newSeason = generateMockFixtures({
      count: 4,
      dateRange: ['2026-05-01', '2026-05-31'],
      matchweeks: [1, 2],
    });
    
    const transition = detectSeasonTransition(newSeason, oldSeason);
    
    expect(transition.detected).toBe(true);
    expect(transition.confidence).toBeGreaterThanOrEqual(0.85);
    expect(transition.signals.massDisappearance).toBe(true);
    expect(transition.signals.temporalGap).toBe(true);
  });
  
  it('does not mistake website redesign for transition', () => {
    const original = generateMockFixtures({ count: 25 });
    const redesigned = transformFixtureFormat(original); // Same data, different structure
    
    const anomaly = detectAnomalousChanges(original, redesigned);
    
    expect(anomaly).toBe(AnomalyType.WEBSITE_CHANGE);
    expect(detectSeasonTransition(redesigned, original).detected).toBe(false);
  });
  
  it('generates correct season IDs', () => {
    const fixtures = [
      { date: new Date('2026-01-15') },
      { date: new Date('2026-02-20') },
    ];
    
    const seasonId = generateSeasonId(fixtures);
    
    expect(seasonId).toBe('2026-Q1');
  });
});
```

### References

- [Hidden Dynamics of Soccer Leagues: Predictive Power of Partial Standings](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6919612/)
- [Change Point Detection in Player Performance Metrics](https://arxiv.org/pdf/2510.25961)
- [Database Schema Design for Scalability](https://dev.to/dhanush___b/database-schema-design-for-scalability-best-practices-techniques-and-real-world-examples-for-ida)
