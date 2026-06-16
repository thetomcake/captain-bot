# Test Mocking Patterns

**Philosophy**: Mock at service boundaries, not library boundaries

## Core Principles

### ✅ DO: Mock at Service Boundaries

Mock the **services and external integrations** that your code depends on:

```typescript
// Mock the scraper service interface
const mockScraper = new MockFixtureScraper();
const fixtureService = new FixtureService(db, seasonService, mockScraper);
```

**Why**: Service boundaries represent your application's architecture. Mocking here:
- Tests your business logic integration
- Allows you to control external behavior
- Remains stable as libraries change
- Makes tests fast and reliable

### ❌ DON'T: Mock Library Boundaries

Don't mock the **libraries and tools** you use internally:

```typescript
// ❌ BAD: Don't mock axios, cheerio, drizzle
vi.mock('axios');
vi.mock('cheerio');
vi.mock('drizzle-orm');
```

**Why**: Library mocking:
- Creates brittle tests that break on library updates
- Tests your mocks, not your code
- Hides integration bugs
- Adds maintenance burden

## Test Strategy by Layer

### Database Tests

**Use**: Real Drizzle ORM + better-sqlite3 with `:memory:` database

```typescript
const sqlite = new Database(':memory:');
const db = drizzle(sqlite, { schema });
```

**Why**: 
- Zero I/O overhead (in-memory)
- Full SQL semantics (no mocking)
- Tests actual queries and constraints
- Fast (<10ms per test)

### Web Scraping Tests

**Use**: Real Axios + Cheerio with static HTML test fixtures

```typescript
const mockScraper = new MockFixtureScraper();
// Reads from tests/fixtures/html/manvfat-fixtures.html
```

**Why**:
- No real HTTP calls (instant)
- Real parsing logic tested
- Control test data precisely
- No network flakiness

### WhatsApp Tests

**Use**: The `FakeGateway` (`tests/helpers/fake-gateway.ts`), which implements the MVP's own
`IWhatsAppGateway` port (`src/whatsapp/gateway-port.ts`) — the single seam over the in-repo
WhatsApp Gateway library. The MVP never imports Baileys (SC-011, guarded by
`tests/integration/whatsapp/no-baileys-import.test.ts`); all WhatsApp behaviour flows through the
port, so the fake is a drop-in for the real `WhatsAppGateway`.

```typescript
import { FakeGateway } from '#tests/helpers/fake-gateway.js';

const gateway = new FakeGateway();
gateway.simulateMessage({ text: '!postpoll', sender: gateway.identities.alice });
gateway.simulatePollVote({ pollId, voter: gateway.identities.alice, selectedOptions: [0] });
// Assert against gateway.sentPolls / gateway.sentMessages / gateway.deletedMessages.
```

**Why**:
- Can't run real WhatsApp in CI; the Gateway library owns the Baileys integration.
- `IWhatsAppGateway` is the MVP's own service boundary — mock there, never Baileys internals.
- Interactive pairing/live votes are validated via the Gateway's manual `bin/` entry points +
  `quickstart.md`, not the automated suite.

### Parser Tests

**Use**: Pure functions with comprehensive test cases (no mocking needed)

```typescript
describe('stat parser', () => {
  it('should parse goals', () => {
    const result = parseStatMessage('I scored 2 goals');
    expect(result.goals).toBe(2);
  });
});
```

**Why**:
- Pure logic with no dependencies
- Fast and deterministic
- No mocking required

## Implementation Examples

### MockFixtureScraper (Service Boundary Mock)

```typescript
// tests/helpers/mock-scraper.ts
export class MockFixtureScraper implements IFixtureScraper {
  private htmlContent: string;

  constructor(htmlContent?: string) {
    // Load static HTML from fixture file
    if (!htmlContent) {
      this.htmlContent = readFileSync(
        'tests/fixtures/html/manvfat-fixtures.html', 
        'utf-8'
      );
    } else {
      this.htmlContent = htmlContent;
    }
  }

  async fetchHtml(_url: string): Promise<string> {
    // No HTTP call - return static HTML
    return this.htmlContent;
  }

  parseFixtures(html: string): Fixture[] {
    // Use REAL parser with static HTML
    return scrapeFixtures(html);
  }
}
```

**Key Points**:
- Implements the `IFixtureScraper` interface (service boundary)
- Uses **real** `scrapeFixtures()` parser (library not mocked)
- Controls input (static HTML) instead of mocking Axios/Cheerio
- Fast (no network) and reliable (deterministic)

### ErrorMockScraper (Error Scenarios)

```typescript
export class ErrorMockScraper implements IFixtureScraper {
  constructor(private errorMessage: string = 'Network error') {}

  async fetchHtml(_url: string): Promise<string> {
    throw new Error(this.errorMessage);
  }

  parseFixtures(_html: string): Fixture[] {
    return [];
  }
}
```

**Use Case**: Testing error handling without real network failures

## Test Performance

### Before (Phase 3 - Real HTTP calls)
- **Total**: 169 seconds
- **Fixture tests**: 156 seconds
- **Problem**: Real HTTP to manvfatfootball.com

### After (Phase 3.5 - Service boundary mocking)
- **Total**: 15.55 seconds
- **Fixture tests**: 1.25 seconds
- **Improvement**: **91% faster**

## When to Use Each Approach

| Scenario | Approach | Example |
|----------|----------|---------|
| Database operations | Real DB (`:memory:`) | `new Database(':memory:')` |
| HTML parsing | Real library + static fixtures | Cheerio with fixture HTML |
| HTTP requests | Mock at service boundary | `MockFixtureScraper` |
| External APIs (WhatsApp) | Mock at service boundary | `MockWhatsAppClient` |
| Pure logic | Direct testing, no mocks | Parser functions |

## Benefits of This Approach

1. **Fast**: No real network/disk I/O
2. **Reliable**: Deterministic, no flaky tests
3. **Maintainable**: Mocks match our interfaces, not library internals
4. **Real**: Actual library code executes (Drizzle, Cheerio, etc.)
5. **Safe**: Integration bugs caught early

## Anti-Patterns to Avoid

### ❌ Mocking Everything

```typescript
// BAD: Over-mocking
vi.mock('axios');
vi.mock('cheerio');
vi.mock('drizzle-orm');
vi.mock('../services/fixture-service');
```

**Problem**: You're testing mocks, not code

### ❌ Mocking Library Internals

```typescript
// BAD: Mocking Baileys internals
vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn(() => ({
    sendMessage: vi.fn(),
    // ... 50 more methods
  }))
}));
```

**Problem**: Brittle, breaks on library updates

### ❌ No Mocking at All (Slow Tests)

```typescript
// BAD: Real HTTP in tests
const fixtures = await axios.get('https://manvfatfootball.com/club/watford/');
```

**Problem**: Slow, flaky, requires network

## What NOT to Test

Following the testing philosophy in `.specify/memory/constitution.md` Principle II:

### ❌ Library Behavior

Don't test that third-party libraries work as documented:
- axios retry logic
- cheerio HTML parsing edge cases
- drizzle ORM query generation
- Node.js process.exit() codes
- stderr vs stdout routing

**Why**: These are the library's responsibility. If axios doesn't retry, that's an axios bug. Testing library behavior wastes time and creates false confidence.

### ❌ Implementation Details

Don't test HOW something works, test WHAT it does:
- Regex patterns for date/time formatting
- Table separator characters (│, ─, ┼)
- Internal class methods not exposed via public API
- CSS selector strings

**Why**: Implementation can change without breaking requirements. Tests should allow refactoring without modification.

### ❌ Placeholder Tests

Remove tests with no real assertions:

```typescript
// ❌ BAD: Provides zero value
it('should retry failed scrapes with exponential backoff', () => {
  expect(true).toBe(true); // Placeholder
});
```

**Why**: These give false confidence and pollute test output. Either implement the test properly or remove it.

### ❌ Framework Behavior

Don't test that the framework or runtime works correctly:
- Process exit codes (testing Node.js behavior)
- Error routing to stderr (testing Node.js streams)
- Argument parsing (testing minimist library)
- Help text formatting (testing CLI framework)

**Why**: These tests break when you change frameworks but don't validate any business requirements.

## What TO Test

### ✅ Business Requirements

Test requirements from `spec.md` (FR-*, SC-* identifiers):

```typescript
// ✅ GOOD: Tests requirement FR-002
it('should extract fixtures from club URL', async () => {
  const fixtures = await fixtureService.fetchFixtures(teamId);
  expect(fixtures.length).toBeGreaterThan(0);
});

// ✅ GOOD: Tests requirement SC-001 (performance)
it('should return fixtures within 5 seconds', async () => {
  const start = Date.now();
  await fixtureService.fetchFixtures(teamId);
  expect(Date.now() - start).toBeLessThan(5000);
});
```

### ✅ Data Transformations

Test your domain logic and data transformations:

```typescript
// ✅ GOOD: Tests our parsing logic
it('should parse "Week 7 - June 29th" format', () => {
  const date = extractDate('Week 7 - June 29th', 2026);
  expect(date).toBe('2026-06-29');
});
```

### ✅ User-Facing Behavior

Test features the user interacts with:

```typescript
// ✅ GOOD: Tests user-visible feature
it('should filter by season with --season flag', () => {
  const output = execSync('captain-stats fixtures --season 1');
  expect(output).toContain('Season 1');
});
```

## Summary

**Test requirements (WHAT), not implementation (HOW). Mock at service boundaries (your interfaces), use real libraries with controlled inputs (test fixtures).**

This gives you fast, reliable tests that actually validate your code's behavior.

## Test Helper Library

### Always Use These Helpers

**Database Setup**:
```typescript
import { createTestDatabase } from '../helpers/test-database.js';

const { db, sqlite, close } = createTestDatabase();
// Database is in-memory, migrated, ready to use
// Call close() in afterEach if needed
```

**Configuration Setup**:
```typescript
import { createTestConfig, setTestEnvironment } from '../helpers/test-config.js';

const config = createTestConfig({ teamName: 'Custom Team' });
setTestEnvironment(config);
// Environment variables are now set for the test
// No cleanup needed - just set fresh values for each test
```

**CLI Testing**:
```typescript
import { getDatabase, closeDatabase } from '#src/database/client.js';
import { fixturesCommand } from '#src/cli/commands/fixtures.js';

// Set up environment with :memory: database
setTestEnvironment(createTestConfig({ databasePath: ':memory:' }));

// Call command directly (it will use getDatabase() from env)
await fixturesCommand({ json: true });

// Clean up in afterEach
afterEach(() => {
  closeDatabase(); // Resets the singleton
});
```

### Testing Principles

1. **Memory-Only**: All databases use `:memory:`, no temp files or directories
2. **Direct Calls**: Import and call functions directly, don't spawn processes
3. **Config in Code**: No .env files, use `createTestConfig()` and `setTestEnvironment()`
4. **One E2E Test**: Keep 1 smoke test with `execSync` for binary validation only

### Benefits

- **Fast**: <2 seconds for full suite, <70ms average per test
- **No I/O**: Everything in memory, no disk operations
- **Consistent**: Same setup across all tests
- **Maintainable**: Single source of truth for test patterns
