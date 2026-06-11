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

- [ ] T023 [P] [US1] Create fixture scraper unit tests in tests/unit/scrapers/fixture-scraper.test.ts (static HTML parsing with axios + cheerio; tests must validate extraction of date, time, opponent, venue per FR-002)
- [ ] T024 [P] [US1] Create fixture service integration tests in tests/integration/fixtures/fixture-retrieval.test.ts (end-to-end scraping, caching, error handling)
- [ ] T025 [P] [US1] Create CLI fixtures command contract tests in tests/integration/cli/fixtures-command.test.ts (output formats, exit codes per cli-interface.md)
- [ ] T026 [P] [US1] Fetch and save live HTML from manvfatfootball.com/club/watford/ to tests/fixtures/html/manvfat-fixtures.html (capture actual page structure for realistic scraper testing)
- [ ] T027 [US1] Verify static scraping can extract all FR-002 required fields (date, time, opponent, venue) from live manvfatfootball.com club page HTML (document CSS selectors and extraction strategy)

### Implementation for User Story 1

#### Scraping Layer

- [ ] T028 [US1] Implement fixture scraper in src/scraping/fixture-scraper.ts using axios + cheerio for static HTML parsing per research.md
- [ ] T029 [US1] Add retry logic and rate limiting to scraper per research.md error handling patterns

#### Service Layer

- [ ] T030 [US1] Implement FixtureService in src/services/fixture-service.ts (scrape, cache, detect changes per data-model.md)
- [ ] T031 [US1] Implement SeasonService in src/services/season-service.ts (get/create current season, season boundary detection per research.md)
- [ ] T032 [US1] Add fixture database operations: insert, update, query by season

#### Fixture Change Detection (FR-021)

- [ ] T033 [US1] Implement fixture change detection in FixtureService (compare scraped fixtures to stored games, detect date/time/venue changes per FR-021)
- [ ] T034 [US1] Add delete poll + responses database operations (cascade delete poll and all poll_responses for a given fixture when rescheduled)
- [ ] T035 [US1] Add automatic re-poll posting when fixture rescheduled (delete old poll records, trigger new poll creation per FR-021)
- [ ] T036 [US1] Add logging for fixture rescheduling events (old values, new values, poll deletion/recreation per quickstart.md)

#### CLI Commands

- [ ] T037 [US1] Implement `captain-stats fixtures` command in src/cli/commands/fixtures.ts per cli-interface.md
- [ ] T038 [US1] Implement `captain-stats sync` command in src/cli/commands/sync.ts per cli-interface.md
- [ ] T039 [US1] Implement `captain-stats init` command in src/cli/commands/init.ts per cli-interface.md
- [ ] T040 [US1] Add table output formatter in src/cli/output/table.ts for fixtures display
- [ ] T041 [US1] Add JSON output formatter in src/cli/output/json.ts for fixtures data

#### Integration

- [ ] T042 [US1] Wire fixtures command to CLI router in src/cli/index.ts
- [ ] T043 [US1] Wire sync command to CLI router in src/cli/index.ts
- [ ] T044 [US1] Wire init command to CLI router in src/cli/index.ts
- [ ] T045 [US1] Add validation and error handling for all US1 commands
- [ ] T046 [US1] Add logging for fixture operations (scrape, sync, display)

**Checkpoint**: User Story 1 complete - fixtures can be viewed and synced independently

---

## Phase 4: User Story 2 - Post Availability Polls (Priority: P2)

**Goal**: Automatically post availability polls to WhatsApp after each game

**Independent Test**: Can connect to WhatsApp, post poll for next fixture, track responses

### Tests for User Story 2 (Test-First)

- [ ] T047 [P] [US2] Create WhatsApp client unit tests in tests/unit/whatsapp/client.test.ts (connection, auth state, mocked Baileys)
- [ ] T048 [P] [US2] Create poll manager unit tests in tests/unit/whatsapp/poll-manager.test.ts (poll formatting, posting, response tracking)
- [ ] T049 [P] [US2] Create poll service integration tests in tests/integration/whatsapp/poll-service.test.ts (end-to-end poll flow with test group)
- [ ] T050 [P] [US2] Create CLI poll command contract tests in tests/integration/cli/poll-command.test.ts per cli-interface.md

### Implementation for User Story 2

#### WhatsApp Integration

- [ ] T051 [US2] Implement database-backed auth state in src/whatsapp/auth.ts per research.md (BufferJSON serialization, Drizzle storage)
- [ ] T052 [US2] Create WhatsApp client wrapper in src/whatsapp/client.ts (Baileys initialization, QR code display, connection management per research.md)
- [ ] T053 [US2] Implement poll manager in src/whatsapp/poll-manager.ts (create polls, format messages, post to group per research.md poll pattern)
- [ ] T054 [US2] Implement message handler in src/whatsapp/message-handler.ts (group filtering, poll response capture per research.md)
- [ ] T055 [US2] Add rate limiting to WhatsApp operations per research.md (1 msg/12 seconds = 5 msg/minute)

#### Service Layer

- [ ] T056 [US2] Implement PollService in src/services/poll-service.ts (schedule poll, post poll, track responses)
- [ ] T057 [US2] Add poll database operations: insert poll record, upsert poll responses per data-model.md
- [ ] T058 [US2] Add WhatsApp user database operations: create/update users from JID per data-model.md

#### CLI and Daemon

- [ ] T059 [US2] Implement `captain-stats poll` command in src/cli/commands/poll.ts per cli-interface.md
- [ ] T060 [US2] Implement daemon mode in src/cli/commands/daemon.ts (WhatsApp connection, message monitoring, graceful shutdown per research.md)
- [ ] T061 [US2] Add scheduled poll posting logic (day after game completion) using Croner per research.md
- [ ] T062 [US2] Wire poll command to CLI router in src/cli/index.ts
- [ ] T063 [US2] Wire daemon command to CLI router in src/cli/index.ts
- [ ] T064 [US2] Add validation and error handling for US2 commands

**Checkpoint**: User Story 2 complete - polls can be posted and responses tracked independently

---

## Phase 5: User Story 3 - Capture Player Stats from Chat (Priority: P3)

**Goal**: Automatically capture stats (goals, assists, weight, food) from WhatsApp messages

**Independent Test**: Can parse stat messages with confidence scoring, capture within 3-day window, attribute to correct player

### Tests for User Story 3 (Test-First)

- [ ] T065 [P] [US3] Create parser service unit tests in tests/unit/services/parser-service.test.ts (pattern matching, confidence scoring, ambiguity handling per research.md)
- [ ] T066 [P] [US3] Create stat service unit tests in tests/unit/services/stat-service.test.ts (capture window logic, defaults, deduplication)
- [ ] T067 [P] [US3] Create stat capture integration tests in tests/integration/whatsapp/stat-capture.test.ts (end-to-end message→stat flow)
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
- [ ] T113 [P] Add rate limit protection for scraping (respectful crawling per research.md)

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
- **US2 (P2)**: Polls - Depends on US1 (needs fixtures to create polls)
- **US3 (P3)**: Stat Capture - Depends on US1 (needs game completion status), US2 (WhatsApp client reused)
- **US4 (P4)**: View/Edit Stats - Depends on US3 (needs stats to view/edit)
- **US5 (P5)**: Season Transition - Depends on US1 (fixture management), independent testing possible

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

**Within User Stories**:
- All tests for a story marked [P] can run in parallel
- Models within a story marked [P] can run in parallel
- Implementation tasks within story run sequentially (service dependencies)

**Across User Stories** (if team capacity allows):
- After Foundational completes, can start US1, US2, US3 in parallel
- US4 must wait for US3
- US5 can start in parallel with US2/US3

---

## Parallel Example: User Story 1

```bash
# After Foundation completes, launch all US1 tests together:
Task T023: "Create fixture scraper unit tests"
Task T024: "Create fixture service integration tests"
Task T025: "Create CLI fixtures command contract tests"
Task T026: "Create sample HTML fixtures"

# Verify all tests FAIL (red phase)

# Launch parallelizable implementation tasks:
Task T027: "Implement static scraper"
Task T028: "Implement dynamic scraper fallback"

# Sequential tasks follow dependencies:
Task T029: "Create fixture scraper coordinator" (depends on T027, T028)
Task T030: "Add retry logic" (extends T029)
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

### Parallel Team Strategy

With 3+ developers:

1. **Team completes Setup + Foundational together** (critical path)
2. Once Foundational done:
   - Developer A: US1 (Fixtures)
   - Developer B: US2 (Polls) - can start WhatsApp integration in parallel
   - Developer C: Database tooling, test infrastructure
3. After US1 complete:
   - Developer A: US3 (Stats) - needs US1 game status
   - Developer B: Finishes US2, starts US4
   - Developer C: US5 season detection
4. Integration and polish together

---

## Task Count Summary

- **Phase 1 (Setup)**: 10 tasks
- **Phase 2 (Foundational)**: 12 tasks
- **Phase 3 (US1 - Fixtures)**: 23 tasks (4 tests + 1 validation + 14 implementation + 4 FR-021)
- **Phase 4 (US2 - Polls)**: 18 tasks (4 tests + 14 implementation)
- **Phase 5 (US3 - Stats)**: 13 tasks (4 tests + 9 implementation)
- **Phase 6 (US4 - View/Edit)**: 14 tasks (3 tests + 11 implementation)
- **Phase 7 (US5 - Seasons)**: 10 tasks (3 tests + 7 implementation)
- **Phase 8 (Polish)**: 24 tasks

**Total**: 124 tasks

**By User Story**:
- US1: 23 tasks (MVP scope - includes FR-021 fixture rescheduling)
- US2: 18 tasks
- US3: 13 tasks
- US4: 14 tasks
- US5: 10 tasks
- Foundation: 22 tasks
- Polish: 24 tasks

**Suggested MVP Scope**: Phase 1 + Phase 2 + Phase 3 = 45 tasks (US1 only)

---

## Notes

- All tasks follow strict checklist format: `- [ ] [ID] [P?] [Story] Description with file path`
- Test-First per constitution: Tests written before implementation, verified to fail first
- User story independence: Each story can be completed and tested separately
- [P] marker indicates parallelizable tasks (different files, no dependencies)
- File paths follow plan.md project structure
- Constitution compliance checked throughout (CLI-first, TypeScript strict, Security-first)
- All specifications from spec.md user stories are covered
- All entities from data-model.md are implemented
- All CLI commands from cli-interface.md are implemented
- All technical patterns from research.md are applied
- All validation scenarios from quickstart.md can be executed
