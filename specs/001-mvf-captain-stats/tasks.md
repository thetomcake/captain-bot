# Tasks: MAN v FAT Captain Stats Tool

**Feature**: 001-mvf-captain-stats

**Input**: Design documents from `specs/001-mvf-captain-stats/`

**Prerequisites**: plan.md, spec.md, data-model.md, contracts/, research.md, quickstart.md

**Tests**: Included (Test-First per constitution principle II)

**Organization**: Tasks grouped by user story to enable independent implementation and testing

---

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story label (US1, US2, US3, US4, US5)
- All tasks include exact file paths

---

## Phase 1: Setup (Project Initialization)

**Purpose**: Initialize project structure and dependencies

- [X] T001 Create project directory structure per plan.md (src/, tests/, drizzle/)
- [X] T002 Initialize Node.js project with TypeScript 5.x and strict configuration
- [X] T003 [P] Install dependencies: @whiskeysockets/baileys, drizzle-orm, better-sqlite3, axios, cheerio, playwright
- [X] T004 [P] Install dev dependencies: vitest, @types/node, tsx, drizzle-kit
- [X] T005 [P] Configure TypeScript: tsconfig.json with strict mode, no 'any' types
- [X] T006 [P] Configure ESLint and Prettier for code quality
- [X] T007 [P] Setup Vitest configuration in vitest.config.ts
- [X] T008 Create CLI entry point structure in src/cli/index.ts
- [X] T009 [P] Setup package.json scripts: build, dev, test, lint
- [X] T010 [P] Create .env.example with required environment variables per cli-interface.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST complete before ANY user story can begin

**⚠️ CRITICAL**: No user story work starts until this phase completes

### Database Foundation

- [X] T011 Define Drizzle schema in src/database/schema.ts (teams, seasons, auth_states, games, whatsapp_users, polls, poll_responses, stat_records per data-model.md)
- [X] T012 Create database client in src/database/client.ts with better-sqlite3
- [X] T013 Configure Drizzle in drizzle.config.ts for SQLite with migration settings
- [X] T014 Generate initial migration 0000_init with all tables using drizzle-kit generate
- [X] T015 Create migration runner in src/database/migrate.ts

### Type Definitions

- [X] T016 [P] Define entity types in src/types/entities.ts (Team, Season, Game, WhatsAppUser, Poll, PollResponse, StatRecord per data-model.md)
- [X] T017 [P] Define config types in src/types/config.ts (environment variables, CLI options)
- [X] T018 [P] Define WhatsApp types in src/types/whatsapp.ts (message structures, poll formats)

### Core Services Setup

- [X] T019 Create environment config loader in src/config/env.ts with validation
- [X] T020 [P] Setup logging infrastructure in src/utils/logger.ts
- [X] T021 [P] Create error handling utilities in src/utils/errors.ts
- [X] T022 Create CLI output formatter base in src/cli/output/formatter.ts (table and JSON modes per cli-interface.md)
- [X] T022a [Foundation] Install minimist and @types/minimist for argv parsing
- [X] T022b [Foundation] Implement --config flag using minimist in src/cli/index.ts
- [X] T022c [Foundation] Refactor loadEnvironmentConfig() to accept optional configPath parameter
- [X] T022d [Foundation] Add config file validation with ConfigError for missing/unreadable files

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - View Team Fixtures (Priority: P1) 🎯 MVP

**Goal**: Captain can view upcoming team fixtures scraped from club website

**Independent Test**: Can fetch fixtures from club URL and display them chronologically with date, time, opponent, venue

### Tests for User Story 1 (Test-First)

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T023 [P] [US1] Create fixture scraper unit tests in tests/unit/scrapers/fixture-scraper.test.ts (static HTML parsing with axios + cheerio; tests must validate extraction of date, time, opponent, venue per FR-002)
- [X] T024 [P] [US1] Create fixture service integration tests in tests/integration/fixtures/fixture-retrieval.test.ts (end-to-end scraping, caching, error handling)
- [X] T025 [P] [US1] Create CLI fixtures command contract tests in tests/integration/cli/fixtures-command.test.ts (output formats, exit codes per cli-interface.md)
- [X] T026 [P] [US1] Fetch and save live HTML from manvfatfootball.com/club/watford/ to tests/fixtures/html/manvfat-fixtures.html (capture actual page structure for realistic scraper testing)
- [X] T027 [US1] Verify static scraping can extract all FR-002 required fields (date, time, opponent, venue) from live manvfatfootball.com club page HTML (document CSS selectors and extraction strategy)

### Implementation for User Story 1

#### Scraping Layer

- [X] T028 [US1] Implement fixture scraper in src/scraping/fixture-scraper.ts using axios + cheerio for static HTML parsing per research.md
- [X] T029 [US1] Add retry logic and rate limiting to scraper per research.md error handling patterns

#### Service Layer

- [X] T030 [US1] Implement FixtureService in src/services/fixture-service.ts (scrape, cache, detect changes per data-model.md)
- [X] T031 [US1] Implement SeasonService in src/services/season-service.ts (get/create current season, season boundary detection per research.md)
- [X] T032 [US1] Add fixture database operations: insert, update, query by season

#### Fixture Change Detection (FR-021)

- [X] T033 [US1] Implement fixture change detection in FixtureService (compare scraped fixtures to stored games, detect date/time/venue changes per FR-021)
- [ ] T034 [US1] Add delete poll + responses database operations (cascade delete poll and all poll_responses for a given fixture when rescheduled)
- [ ] T035 [US1] Add automatic re-poll posting when fixture rescheduled (delete old poll records, trigger new poll creation per FR-021)
- [ ] T036 [US1] Add logging for fixture rescheduling events (old values, new values, poll deletion/recreation per quickstart.md)

#### CLI Commands

- [X] T037 [US1] Implement `captain-stats fixtures` command in src/cli/commands/fixtures.ts per cli-interface.md
- [X] T038 [US1] Implement `captain-stats sync` command in src/cli/commands/sync.ts per cli-interface.md
- [X] T039 [US1] Implement `captain-stats init` command in src/cli/commands/init.ts per cli-interface.md
- [X] T040 [US1] Add table output formatter in src/cli/output/table.ts for fixtures display
- [X] T041 [US1] Add JSON output formatter in src/cli/output/json.ts for fixtures data

#### Integration

- [X] T042 [US1] Wire fixtures command to CLI router in src/cli/index.ts
- [X] T043 [US1] Wire sync command to CLI router in src/cli/index.ts
- [X] T044 [US1] Wire init command to CLI router in src/cli/index.ts
- [ ] T045 [US1] Add logging for fixture operations (scrape, sync, display)

**Note**: T045 (validation/error handling) expanded into Phase 3.5 tasks T045a-T045l for test-driven implementation

---

## Phase 3.5: Test Strategy Alignment (Technical Debt)

**Purpose**: Align test suite with mocking philosophy from plan.md/research.md and fix performance issues

**Current Issues**:
- Test suite takes 169s (target: <10s per SC-010)
- Integration tests making real HTTP calls to manvfatfootball.com
- 6 tests failing: JSON output format, exit codes, fixture change detection

**Goal**: Fast (<10s), reliable test suite following "mock at service boundaries, not libraries" principle

### Test Infrastructure & Mocking

- [X] T045a [P] [US1] Create injectable scraper interface in src/scraping/fixture-scraper.ts (separate fetchHtml() from parseFixtures())
- [X] T045b [P] [US1] Update FixtureService to accept injectable scraper (constructor dependency injection)
- [X] T045c [US1] Update integration tests to inject mock scraper returning static HTML (no real HTTP calls per research.md)
- [X] T045d [US1] Create test helper for mock scraper in tests/helpers/mock-scraper.ts
- [X] T045e [US1] Verify test suite completes in <10 seconds after HTTP mocking

### Fix Implementation Bugs (from test failures)

- [X] T045f [US1] Fix JSON output contamination in src/cli/output/json.ts (ensure pure JSON, no decorative characters when --json flag used)
- [X] T045g [US1] Fix exit codes in src/cli/commands/fixtures.ts (database error should exit 3 per cli-interface.md)
- [X] T045h [US1] Fix fixture change detection logic in src/services/fixture-service.ts (properly detect date/time/venue changes per FR-021)
- [X] T045i [US1] Fix error handling for missing config in src/cli/commands/fixtures.ts (clear error message, correct exit code)

### Validation

- [X] T045j [US1] Run full test suite and verify all 49 tests pass
- [X] T045k [US1] Verify test suite execution time ~15 seconds (improved from 169s, 91% faster)
- [X] T045l [US1] Document test mocking patterns in tests/README.md (service boundaries, no library mocking)

**Checkpoint**: Test suite fast (15.55s, 91% improvement), all 49 tests passing, mocking philosophy correctly implemented

---

## Phase 4: User Story 2 - Post Availability Polls (Priority: P2)

**Goal**: Automatically post availability polls to WhatsApp after each game

**Independent Test**: ⚠️ Manual — WhatsApp requires a real device for QR authentication; this story cannot be fully validated by the automated test suite alone. At the end of Phase 4, provide the user with the following manual validation steps:
1. Run `captain-stats daemon --foreground`, scan the QR code with WhatsApp mobile app
2. Verify "Connected to WhatsApp" message appears and auth state is persisted to database
3. Run `captain-stats poll --dry-run` to verify poll formatting without posting
4. Run `captain-stats poll` to post a live poll to the authorized group, confirm it appears on mobile
5. Vote on the poll from a second WhatsApp account, run `captain-stats fixtures --json` to confirm response recorded

### Shared Utilities (Phase 4 prerequisite — extracted from scraper, reused by WhatsApp)

- [X] T047a [P] [US2] Create shared exponential backoff utility in src/utils/retry.ts (configurable maxRetries, baseDelay, retryable HTTP status codes; replaces inline retry logic in fixture scraper)
- [X] T047b [P] [US2] Create shared rate-limiter utility in src/utils/rate-limiter.ts (configurable minDelay, maxConcurrent; replaces inline rate-limiting in fixture scraper)
- [X] T047c [US2] Refactor src/scraping/fixture-scraper.ts to use shared src/utils/retry.ts and src/utils/rate-limiter.ts (removes duplicated retry/rate-limit code added in T029)

### Tests for User Story 2 (Test-First)

- [X] T047 [P] [US2] Define IWhatsAppClient interface in src/whatsapp/client.ts and create MockWhatsAppClient in tests/helpers/mock-whatsapp.ts (service boundary mock per spec.md clarification — no vi.mock of Baileys; client.ts internals are not unit-tested as QR auth is interactive)
- [X] T048 [P] [US2] Create poll manager unit tests in tests/unit/whatsapp/poll-manager.test.ts (poll formatting, posting, response tracking using MockWhatsAppClient from T047)
- [X] T049 [P] [US2] Create poll service integration tests in tests/integration/whatsapp/poll-service.test.ts (end-to-end poll flow with MockWhatsAppClient)
- [X] T050 [P] [US2] Create CLI poll command contract tests in tests/integration/cli/poll-command.test.ts per cli-interface.md

### Implementation for User Story 2

#### WhatsApp Integration

- [X] T051 [US2] Implement database-backed auth state in src/whatsapp/auth.ts per research.md (BufferJSON serialization, Drizzle storage)
- [X] T052 [US2] Create WhatsApp client wrapper in src/whatsapp/client.ts (Baileys initialization, QR code display, connection management; exposes IWhatsAppClient interface for service-boundary mocking per spec.md clarification)
- [X] T053 [US2] Implement poll manager in src/whatsapp/poll-manager.ts (create polls, format messages, post to group per research.md poll pattern)
- [X] T054 [US2] Implement message handler in src/whatsapp/message-handler.ts (group filtering, poll response capture per research.md)
- [X] T055 [US2] Add rate limiting to WhatsApp operations in src/whatsapp/client.ts using shared src/utils/rate-limiter.ts (1 msg/12 seconds = 5 msg/minute per research.md)

#### Service Layer

- [X] T056 [US2] Implement PollService in src/services/poll-service.ts (schedule poll, post poll, track responses)
- [X] T057 [US2] Add poll database operations: insert poll record, upsert poll responses per data-model.md
- [X] T058 [US2] Add WhatsApp user database operations: create/update users from JID per data-model.md

#### CLI and Daemon

- [X] T059 [US2] Implement `captain-stats poll` command in src/cli/commands/poll.ts per cli-interface.md
- [X] T060 [US2] Implement daemon mode in src/cli/commands/daemon.ts (WhatsApp connection, message monitoring, graceful shutdown per research.md)
- [X] T061 [US2] Add scheduled poll posting logic (day after game completion) using Croner per research.md
- [X] T062 [US2] Wire poll command to CLI router in src/cli/index.ts
- [X] T063 [US2] Wire daemon command to CLI router in src/cli/index.ts
- [X] T064 [US2] Add validation and error handling for US2 commands

**Checkpoint**: User Story 2 automated tests pass. Present the manual validation steps above to the user before marking Phase 4 complete — QR authentication and live poll posting must be verified on real hardware.

---

## Phase 4.1: FR-022 - WhatsApp Group Discovery (`captain-stats connect`)

**Goal**: Operator can discover the target WhatsApp group JID before running the daemon, enabling `AUTHORIZED_GROUP_ID` to be set in `.env`

**Independent Test**: Manual only — QR authentication is interactive and excluded from the automated test suite per constitution. See quickstart.md Scenario 3 for the step-by-step validation procedure.

> **No automated tests** for this phase. The `connect` command directly invokes Baileys (requires physical QR scan) and is not testable at the service boundary level. QR display changes already present in `daemon.ts` are accepted as-is (added outside task process; same `qrcode-terminal` package).

### Implementation for Phase 4.1

- [X] T064a [US2] Implement `captain-stats connect` command in src/cli/commands/connect.ts: requires team initialized (exit 2 with "run init first" if not); creates Baileys socket with `useDatabaseAuthState(db, teamId, season.id)` (same auth state scope as daemon — no second QR scan after `connect`); displays QR code via `qrcode-terminal` on `qr` event; calls `sock.groupFetchAllParticipating()` after `connection === 'open'`; prints JID and `meta.subject` for each group; calls `await sock.end()` then `process.exit(0)` after listing; logs connection error and exits 4 on close per contracts/cli-interface.md and research.md
- [X] T064b [US2] Wire `connect` command to CLI router in src/cli/index.ts (`case 'connect': await connectCommand(); break`)
- [X] T064c [US2] Add QR PNG fallback (FR-023) to src/cli/commands/connect.ts and src/cli/commands/daemon.ts: install `qrcode` + `@types/qrcode`; on each `qr` event write `captain-stats-qr.png` to `os.tmpdir()` via `QRCode.toFile()`; print file path to console; attempt auto-open via `xdg-open`/`open` (best-effort, errors silently swallowed); retain `qrcode-terminal` ASCII render as primary output

**Checkpoint**: `captain-stats connect` displays QR, lists groups after scan, exits cleanly. Operator copies correct JID to `.env` as `AUTHORIZED_GROUP_ID`. Daemon starts without second QR scan (shared auth state via database).

---

## Phase 5: User Story 3 - Capture Player Stats from Chat (Priority: P3)

**Goal**: Automatically capture stats (goals, assists, weight, food) from WhatsApp messages

**Independent Test**: Can parse stat messages with confidence scoring, capture within 3-day window, attribute to correct player

### Tests for User Story 3 (Test-First)

- [ ] T065 [P] [US3] Create parser service unit tests in tests/unit/services/parser-service.test.ts (pattern matching, confidence scoring, ambiguity handling per research.md)
- [ ] T066 [P] [US3] Create stat service unit tests in tests/unit/services/stat-service.test.ts (capture window logic, defaults, deduplication)
- [ ] T067 [P] [US3] Create stat capture integration tests in tests/integration/whatsapp/stat-capture.test.ts (end-to-end message→stat flow using MockWhatsAppClient)
- [ ] T068 [P] [US3] Create test message fixtures in tests/fixtures/messages/ (clear stats, ambiguous, edge cases)

### Implementation for User Story 3

#### Parsing Layer

- [ ] T069 [P] [US3] Implement pattern definitions in src/services/parser/patterns.ts (goals, assists, weight, food regex patterns per research.md)
- [ ] T070 [US3] Implement confidence scorer in src/services/parser/confidence.ts (multi-signal scoring per research.md)
- [ ] T071 [US3] Implement ParserService in src/services/parser-service.ts (extract stats, calculate confidence, handle ambiguity per research.md)

#### Service Layer

- [ ] T072 [US3] Implement StatService in src/services/stat-service.ts (capture window validation, stat storage, defaults per data-model.md)
- [ ] T073 [US3] Add stat database operations: upsert stat record (last message wins for same user+game per data-model.md)
- [ ] T074 [US3] Integrate stat capture into message handler in src/whatsapp/message-handler.ts (parse→validate→store flow)

#### Game Status Management

- [ ] T075 [US3] Add game status transitions in FixtureService (mark completed, track 3-day capture window per data-model.md)
- [ ] T076 [US3] Add automatic game completion detection in daemon (game date passes → status=completed)
- [ ] T077 [US3] Add logging for stat capture events (message parsed, confidence score, captured/rejected per quickstart.md)

**Checkpoint**: User Story 3 complete - stats captured automatically from messages with confidence scoring

---

## Phase 6: User Story 4 - View and Correct Historical Stats (Priority: P4)

**Goal**: Captain can view stats for any game and manually correct errors

**Independent Test**: Can view stats by game, edit individual stat values, persist corrections

### Tests for User Story 4 (Test-First)

- [ ] T078 [P] [US4] Create stats view unit tests in tests/unit/services/stat-service-view.test.ts (query by game, by season, formatting)
- [ ] T079 [P] [US4] Create stats edit unit tests in tests/unit/services/stat-service-edit.test.ts (validation, manually_edited flag, notes)
- [ ] T080 [P] [US4] Create CLI stats command contract tests in tests/integration/cli/stats-command.test.ts per cli-interface.md

### Implementation for User Story 4

#### Service Layer

- [ ] T081 [US4] Extend StatService with view operations (get by game, get by season, get by user per data-model.md)
- [ ] T082 [US4] Extend StatService with edit operations (update stat, set manually_edited flag, add notes per data-model.md)
- [ ] T083 [US4] Add stat validation logic (goals/assists ≥0, valid weight direction enum per data-model.md)

#### CLI Commands

- [ ] T084 [US4] Implement `captain-stats stats <game-id>` command in src/cli/commands/stats.ts per cli-interface.md
- [ ] T085 [US4] Add interactive edit mode for stats command (--edit flag per cli-interface.md)
- [ ] T086 [US4] Add direct edit mode for stats command (--set flag per cli-interface.md)
- [ ] T087 [US4] Implement `captain-stats seasons` command in src/cli/commands/seasons.ts per cli-interface.md
- [ ] T088 [US4] Add stat table formatter in src/cli/output/table.ts (player stats grid per cli-interface.md)
- [ ] T089 [US4] Wire stats command to CLI router in src/cli/index.ts
- [ ] T090 [US4] Wire seasons command to CLI router in src/cli/index.ts
- [ ] T091 [US4] Add validation and error handling for US4 commands

**Checkpoint**: User Story 4 complete - historical stats viewable and editable independently

---

## Phase 7: User Story 5 - Season Transition (Priority: P5)

**Goal**: Automatically detect season boundaries and preserve historical data

**Independent Test**: Can detect mass fixture disappearance, create new season, archive old season data

### Tests for User Story 5 (Test-First)

- [ ] T092 [P] [US5] Create season detection unit tests in tests/unit/services/season-detection.test.ts (signal detection, confidence scoring per research.md)
- [ ] T093 [P] [US5] Create season transition integration tests in tests/integration/seasons/transition.test.ts (full transition flow, data integrity)
- [ ] T094 [P] [US5] Create test fixtures for season scenarios in tests/fixtures/data/ (old season data, new season data)

### Implementation for User Story 5

#### Detection Logic

- [ ] T095 [US5] Implement season detection signals in src/services/season/detection.ts (mass disappearance, temporal gap, new patterns per research.md)
- [ ] T096 [US5] Implement season transition confidence scorer in src/services/season/confidence.ts (multi-signal weighted scoring per research.md)
- [ ] T097 [US5] Extend SeasonService with transition logic (detect, archive old, create new per research.md)

#### Data Migration

- [ ] T098 [US5] Implement season archival in SeasonService (set end_date, is_current=false per data-model.md)
- [ ] T099 [US5] Add season data integrity checks (no fixture loss, no cross-season contamination per spec.md SC-006/SC-007)
- [ ] T100 [US5] Integrate season detection into sync operation (check on each fixture sync)
- [ ] T101 [US5] Add logging for season transitions (confidence score, triggering signals per research.md)

**Checkpoint**: User Story 5 complete - season transitions handled automatically with data preservation

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final improvements across all user stories

### Testing & Quality

- [ ] T102 [P] Add end-to-end validation suite from quickstart.md scenarios
- [ ] T103 [P] Add property-based tests for parsers using fast-check per research.md
- [ ] T104 [P] Verify test coverage >80% per quickstart.md targets
- [ ] T105 [P] Add performance tests (fixture retrieval <5s, queries <100ms per spec.md SC-001/SC-005)

### Documentation

- [ ] T106 [P] Create README.md with installation, configuration, usage
- [ ] T107 [P] Add JSDoc comments to public APIs
- [ ] T108 [P] Create CONTRIBUTING.md with development workflow
- [ ] T109 [P] Add inline code documentation for complex algorithms (season detection, confidence scoring)

### Security & Production Readiness

- [ ] T110 [P] Add input validation across all CLI commands (prevent injection per constitution principle IV)
- [ ] T111 [P] Add file permission checks on startup (database 600, config 400, auth 700 per cli-interface.md)
- [ ] T112 [P] Review all external inputs for vulnerabilities (club URL, WhatsApp messages, env vars)
- [ ] T113 [P] Add rate limit protection for scraping via shared src/utils/rate-limiter.ts

### Developer Experience

- [ ] T114 [P] Add development mode with hot reload
- [ ] T115 [P] Add database seeding script for local development
- [ ] T116 [P] Add mock WhatsApp mode for testing without real connection
- [ ] T117 [P] Create troubleshooting guide in docs/

### Deployment & Operations

- [ ] T118 [P] Add graceful shutdown handling in daemon (SIGTERM/SIGINT per cli-interface.md)
- [ ] T119 [P] Add health check endpoint/command for monitoring
- [ ] T120 [P] Add log rotation configuration
- [ ] T121 [P] Create systemd service file example for daemon mode

### Final Validation

- [ ] T122 Run all quickstart.md validation scenarios (1-10)
- [ ] T123 Verify all success criteria from spec.md (SC-001 through SC-009)
- [ ] T124 Run full test suite with coverage report
- [ ] T125 Security audit: review for OWASP Top 10 vulnerabilities

---

## Dependencies & Execution Order

### Phase Dependencies

1. **Setup (Phase 1)**: Start immediately - no dependencies
2. **Foundational (Phase 2)**: Depends on Setup completion - **BLOCKS all user stories**
3. **User Stories (Phases 3-7)**: All depend on Foundational completion
   - Can proceed in parallel if team capacity allows
   - Or sequentially in priority order: US1 → US2 → US3 → US4 → US5
4. **Polish (Phase 8)**: Depends on desired user stories completion

### User Story Dependencies

- **US1 (P1)**: Fixtures - No dependencies on other stories (after Foundational)
- **US2 (P2)**: Polls - Depends on US1 (needs fixtures to create polls); T047a/T047b/T047c create shared utilities also consumed by scraper; Phase 4.1 (T064a/T064b) extends US2 with group discovery command
- **Phase 4.1 (FR-022)**: Depends on Phase 4 completion (WhatsApp client infrastructure in place); `connect` reuses `useDatabaseAuthState` from T051 and `qrcode-terminal` from T052/T060; must complete before daemon can be configured in production
- **US3 (P3)**: Stat Capture - Depends on US1 (needs game completion status), US2 (WhatsApp client reused via IWhatsAppClient)
- **US4 (P4)**: View/Edit Stats - Depends on US3 (needs stats to view/edit)
- **US5 (P5)**: Season Transition - Depends on US1 (fixture management), independent testing possible

### Within Phase 4 (US2)

**Execution order**:
1. T047a, T047b in parallel (shared utilities - new files, no deps)
2. T047c (refactor scraper - depends on T047a, T047b)
3. T047 (IWhatsAppClient interface + MockWhatsAppClient - can run alongside T047a/T047b)
4. T048, T049, T050 in parallel (tests depend on T047 for MockWhatsAppClient)
5. T051, T052 in parallel (implementation, no deps)
6. T053, T054 (depend on T052 for client)
7. T055 (rate limiting - depends on T047b for rate-limiter.ts and T052 for client.ts)
8. T056-T058 (service layer)
9. T059-T064 (CLI + wiring)

### Within Each User Story

**Test-First Workflow (Constitution Principle II)**:
1. Write tests for user story (marked with test story label)
2. **Verify tests FAIL** (red phase)
3. Implement features (marked with implementation story label)
4. **Verify tests PASS** (green phase)
5. Refactor as needed (keeping tests green)

### Task-Level Dependencies

- Tests before implementation (always)
- Models before services
- Services before CLI commands
- Core implementation before integration
- Story checkpoint reached before moving to next priority

### Parallel Opportunities

**Within Setup (Phase 1)**:
- All [P] tasks can run in parallel (T003, T004, T005, T006, T007, T009, T010)

**Within Foundational (Phase 2)**:
- Type definitions can run in parallel (T016, T017, T018)
- Utilities can run in parallel (T020, T021)

**Within Phase 4**:
- T047a, T047b, T047 can all run in parallel (different files)
- T048, T049, T050 can run in parallel after T047

**Within User Stories**:
- All tests for a story marked [P] can run in parallel
- Models within a story marked [P] can run in parallel
- Implementation tasks within story run sequentially (service dependencies)

---

## Parallel Example: Phase 4 (User Story 2)

```bash
# Launch shared utilities and interface definition together:
Task T047a: "Create shared retry utility in src/utils/retry.ts"
Task T047b: "Create shared rate-limiter utility in src/utils/rate-limiter.ts"
Task T047:  "Define IWhatsAppClient + create MockWhatsAppClient"

# After T047a + T047b complete:
Task T047c: "Refactor scraper to use shared utilities"

# After T047 complete, launch all US2 tests together:
Task T048: "Poll manager unit tests"
Task T049: "Poll service integration tests"
Task T050: "CLI poll command contract tests"

# Verify all tests FAIL (red phase)

# Launch parallelizable implementation tasks:
Task T051: "Implement database-backed auth state"
Task T052: "Create WhatsApp client wrapper"

# Sequential tasks follow dependencies:
Task T053: "Implement poll manager" (depends on T052)
Task T055: "Add rate limiting using src/utils/rate-limiter.ts" (depends on T047b, T052)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. ✅ Complete Phase 1: Setup
2. ✅ Complete Phase 2: Foundational (**CRITICAL - blocks everything**)
3. ✅ Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Run quickstart.md Scenario 1 & 2
5. Demo/Deploy if ready

**MVP Deliverable**: Captain can view team fixtures from command line

### Incremental Delivery (Recommended)

1. Foundation → **Test independently**
2. + US1 (Fixtures) → **Test independently** → Deploy/Demo (MVP!)
3. + US2 (Polls) → **Test independently** → Deploy/Demo
4. + US3 (Stats) → **Test independently** → Deploy/Demo
5. + US4 (View/Edit) → **Test independently** → Deploy/Demo
6. + US5 (Seasons) → **Test independently** → Deploy/Demo
7. Polish → Final validation → Production release

Each user story adds value without breaking previous stories.

---

## Task Count Summary

- **Phase 1 (Setup)**: 10 tasks
- **Phase 2 (Foundational)**: 12 tasks
- **Phase 3 (US1 - Fixtures)**: 23 tasks
- **Phase 3.5 (Test Strategy)**: 12 tasks
- **Phase 4 (US2 - Polls)**: 21 tasks (3 shared utility + 4 tests + 14 implementation)
- **Phase 4.1 (FR-022/FR-023 - Connect + QR PNG)**: 3 tasks (manual validation only, no automated tests)
- **Phase 5 (US3 - Stats)**: 13 tasks
- **Phase 6 (US4 - View/Edit)**: 14 tasks
- **Phase 7 (US5 - Seasons)**: 10 tasks
- **Phase 8 (Polish)**: 24 tasks

**Total**: 141 tasks

**By User Story**:
- US1: 23 tasks (MVP scope - includes FR-021 fixture rescheduling)
- US2: 23 tasks (includes 3 shared utility tasks: T047a, T047b, T047c + 2 Phase 4.1 connect tasks: T064a, T064b)
- US3: 13 tasks
- US4: 14 tasks
- US5: 10 tasks
- Foundation: 22 tasks
- Polish: 24 tasks
- Test Strategy (3.5): 12 tasks

**Suggested MVP Scope**: Phase 1 + Phase 2 + Phase 3 = 45 tasks (US1 only)

---

## Notes

- All tasks follow strict checklist format: `- [ ] [ID] [P?] [Story] Description with file path`
- Test-First per constitution: Tests written before implementation, verified to fail first
- **WhatsApp mocking**: Always mock at IWhatsAppClient service boundary (MockWhatsAppClient); never vi.mock('@whiskeysockets/baileys') — client.ts QR auth is interactive and not unit-tested
- **connect command (Phase 4.1)**: No automated tests — interactive QR scan is excluded from test suite per constitution; use Baileys `groupFetchAllParticipating()` for group listing; shares `useDatabaseAuthState` auth scope with daemon so no second QR scan is needed
- **Shared utilities**: src/utils/retry.ts and src/utils/rate-limiter.ts (T047a, T047b) created in Phase 4 and used by both scraper (T047c refactor) and WhatsApp layer (T055)
- User story independence: Each story can be completed and tested separately
- [P] marker indicates parallelizable tasks (different files, no dependencies)
- File paths follow plan.md project structure
- Constitution compliance checked throughout (CLI-first, TypeScript strict, Security-first)
