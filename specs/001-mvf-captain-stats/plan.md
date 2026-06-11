# Implementation Plan: MAN v FAT Captain Stats Tool

**Branch**: `001-mvf-captain-stats` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-mvf-captain-stats/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

A CLI tool to automate MAN v FAT Football team management by fetching fixtures from club websites, posting availability polls to WhatsApp after each game, capturing player stats from natural language messages within 3 days post-game, and maintaining historical data across multiple seasons. Built with TypeScript (strict mode), Baileys WhatsApp library, Drizzle ORM with SQLite (swappable to other SQL databases), and Axios/Cheerio/Playwright for web scraping.

## Technical Context

**Language/Version**: TypeScript 5.x (strict mode, no 'any' types), Node.js 22.x (current release, Baileys compatible)

**Primary Dependencies**:
- @whiskeysockets/baileys (WhatsApp Web API via WebSocket)
- drizzle-orm + drizzle-kit (type-safe ORM with migrations)
- better-sqlite3 (SQLite driver for Node.js)
- axios + cheerio (static HTML scraping)
- playwright (fallback for dynamic content)
- minimist (argv parsing for CLI)

**Dependency Philosophy**: Minimize infrastructure dependencies for supply chain security and transparency. Use libraries for domain-specific complexity (WhatsApp protocol → Baileys, SQL type safety → Drizzle, web scraping → Playwright), not for thin wrappers over Node.js APIs (logging, CLI routing, formatting). Custom implementations (~400 lines total) provide full control without the maintenance burden of 100+ transitive dependencies.

**Storage**: SQLite (development/production), with database abstraction via Drizzle ORM to support PostgreSQL, MySQL, or other SQL databases in future

**Testing**: Vitest (modern TypeScript test framework) or Jest with ts-jest

**Target Platform**: Node.js CLI application (Linux/macOS/Windows), long-running daemon for WhatsApp monitoring

**Project Type**: CLI tool with daemon mode for continuous WhatsApp monitoring and scheduled tasks

**Performance Goals**:
- Fixture retrieval: <5 seconds
- Poll posting: within 1 hour of scheduled time
- Message processing: real-time during 3-day capture window
- Database queries: <100ms for historical data views

**Constraints**:
- WhatsApp rate limits: conservative messaging to avoid bans (1-5 messages/minute)
- Single WhatsApp group authorization only
- No production credentials in tests
- Offline-capable for viewing historical stats
- UK timezone default for fixture times

**Scale/Scope**:
- Single team (10-15 players)
- 20-30 games per season
- 5+ seasons of historical data
- ~100-200 stat messages per season
- ~20-30 polls per season

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. CLI-First ✅ PASS
**Compliance**: Feature is designed as a CLI tool with commands for fixture viewing, stat correction, and historical data access. Text-based output for composability. JSON output option for scripting.

**Implementation Notes**:
- Primary interface: `captain-stats fixtures`, `captain-stats stats <game-id>`, `captain-stats poll`
- Daemon mode: `captain-stats daemon` for WhatsApp monitoring
- Output formats: human-readable tables (default), JSON with `--json` flag

### II. Test-First ✅ PASS (with caveat)
**Compliance**: Tests will be written before implementation for all core business logic.

**Implementation Notes**:
- Contract tests for WhatsApp interactions (mocked Baileys SDK)
- Integration tests for database operations
- Unit tests for stat parsing, fixture extraction, season detection
- **Caveat**: Initial WhatsApp integration will require manual verification due to QR code authentication and real-time message monitoring

### III. TypeScript ✅ PASS
**Compliance**: Strict TypeScript configuration enforced. All dependencies chosen for native TypeScript support.

**Implementation Notes**:
- `tsconfig.json` with `strict: true`, `noImplicitAny: true`
- Baileys: native TypeScript library
- Drizzle ORM: TypeScript-first with compile-time type checking
- No 'any' types permitted in codebase

### IV. Security-First ✅ PASS
**Compliance**: Multiple security considerations addressed in design.

**Implementation Notes**:
- WhatsApp session keys stored securely (custom auth state, not default)
- Single group authorization explicitly enforced (no unauthorized access)
- No credential storage in test fixtures
- Conservative stat capture to avoid privacy overreach (weight direction only, no actual values)
- Input validation for all natural language parsing
- Rate limiting for web scraping to respect target servers
- Database parameterized queries via Drizzle ORM (SQL injection prevention)

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── cli/
│   ├── index.ts          # CLI entry point, command definitions
│   ├── commands/
│   │   ├── fixtures.ts   # Fixtures command
│   │   ├── stats.ts      # Stats view/edit commands
│   │   ├── daemon.ts     # Daemon mode for WhatsApp monitoring
│   │   └── poll.ts       # Manual poll posting
│   └── output/
│       ├── table.ts      # Human-readable table formatting
│       └── json.ts       # JSON output formatting
├── database/
│   ├── schema.ts         # Drizzle schema definitions
│   ├── migrations/       # Auto-generated migration files
│   └── client.ts         # Database connection setup
├── scraping/
│   ├── fixture-scraper.ts # Club website scraping logic
│   ├── static-scraper.ts  # Axios + Cheerio implementation
│   └── dynamic-scraper.ts # Playwright fallback
├── whatsapp/
│   ├── client.ts         # Baileys WhatsApp client wrapper
│   ├── auth.ts           # Custom auth state management
│   ├── poll-manager.ts   # Poll posting logic
│   └── message-handler.ts # Message event processing
├── services/
│   ├── fixture-service.ts    # Fixture retrieval and caching
│   ├── stat-service.ts       # Stat capture and storage
│   ├── poll-service.ts       # Poll management
│   ├── season-service.ts     # Season detection and management
│   └── parser-service.ts     # Natural language stat parsing
└── types/
    ├── entities.ts       # Core entity types
    ├── config.ts         # Configuration types
    └── whatsapp.ts       # WhatsApp-specific types

tests/
├── unit/
│   ├── parsers/          # Stat parsing tests
│   ├── services/         # Service layer tests
│   └── scrapers/         # Scraping logic tests
├── integration/
│   ├── database/         # Database operation tests
│   ├── fixtures/         # End-to-end fixture retrieval
│   └── whatsapp/         # WhatsApp integration tests (mocked)
└── fixtures/
    ├── html/             # Sample HTML for scraper tests
    ├── messages/         # Sample WhatsApp messages
    └── data/             # Test data sets

drizzle.config.ts         # Drizzle configuration
tsconfig.json             # TypeScript strict configuration
package.json
.env.example              # Config template (club URL, group ID)
```

**Structure Decision**: Single project structure chosen. This is a CLI tool with supporting services, not requiring separate frontend/backend or multi-project architecture. All code is TypeScript with clear separation between CLI interface, business logic (services), data access (database), and external integrations (WhatsApp, scraping).

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
