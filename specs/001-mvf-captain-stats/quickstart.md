# Quickstart Validation Guide

**Feature**: 001-mvf-captain-stats
**Date**: 2026-06-10

## Overview

This guide provides runnable validation scenarios to prove the Captain Stats feature works end-to-end. Each scenario includes prerequisites, commands to run, and expected outcomes. This is a validation/testing guide - detailed implementation code belongs in tasks.md.

---

## Prerequisites

### System Requirements
- Node.js 18+ installed
- npm package manager
- Linux/macOS/Windows with terminal access
- Internet connection (for WhatsApp, fixture scraping)

### Initial Setup
1. Clone repository
2. Install dependencies: `npm install`
3. Build TypeScript: `npm run build`
4. Initialize database: `npm run init`

---

## Validation Scenario 1: Configuration & Database Setup

**Goal**: Verify project initialization and database creation.

### Commands
```bash
# Initialize configuration
./bin/captain-stats init --interactive

# When prompted, enter:
# Club URL: https://manvfatfootball.org/club/watford/
# Team: Test Team Alpha

# Verify database created
ls -l captain-stats.db

# Verify configuration
cat .env | grep CLUB_URL
```

### Expected Outcome
- `.env` file created with CLUB_URL and TEAM_IDENTIFIER
- `captain-stats.db` SQLite file created
- Database contains initial schema (clubs, teams, seasons, games, whatsapp_users, poll_responses, stat_records tables)
- First season created with `is_current = true`
- Exit code: 0

### Validation Queries
```bash
# Check tables created
sqlite3 captain-stats.db ".tables"
# Expected: clubs, teams, seasons, games, whatsapp_users, poll_responses, stat_records

# Check season created
sqlite3 captain-stats.db "SELECT * FROM seasons;"
# Expected: 1 row with season_number=1, is_current=1
```

### Success Criteria
✅ Database file exists with correct schema
✅ Configuration file contains valid club URL
✅ First season automatically created
✅ No errors in output

---

## Validation Scenario 2: Fixture Retrieval

**Goal**: Verify scraping fixtures from MAN v FAT Football website.

### Prerequisites
- Scenario 1 completed successfully
- Internet connection available
- Target club page exists and accessible

### Commands
```bash
# Manually trigger fixture sync
./bin/captain-stats sync

# View retrieved fixtures
./bin/captain-stats fixtures

# Verify fixture data (JSON format)
./bin/captain-stats fixtures --json
```

### Expected Outcome
- Fixtures fetched from club website
- At least 1 fixture stored in database
- Fixtures displayed in chronological order
- Each fixture has: date, time, opponent, venue
- Exit code: 0

### Test with Mock Data (if website unavailable)
```bash
# Run integration test with sample HTML
npm run test:integration -- fixtures-scraping.test.ts

# This test uses fixture HTML samples from tests/fixtures/html/
```

### Expected JSON Structure
```json
{
  "season": 1,
  "is_current": true,
  "fixtures": [
    {
      "id": "uuid",
      "date": "2026-06-15",
      "time": "14:00",
      "opponent": "Red Devils",
      "venue": "Victoria Park",
      "status": "scheduled"
    }
  ]
}
```

### Success Criteria
✅ Fixtures successfully scraped and stored
✅ All required fields populated (date, opponent, venue)
✅ Fixtures ordered by date
✅ Performance: <5 seconds for fixture retrieval
✅ No scraping errors

---

## Validation Scenario 3: WhatsApp Setup — Connect & Discover Group JID

**Goal**: Verify the one-time WhatsApp onboarding flow: QR authentication, group listing, and `AUTHORIZED_GROUP_ID` configuration.

> **This scenario must be completed before Scenario 4 (Poll Posting) and before running the daemon.**

### Prerequisites
- Scenario 1 completed (database and team initialized)
- WhatsApp mobile app installed and accessible
- `.env` file does **not** yet have `AUTHORIZED_GROUP_ID` set (first-time setup)

### Step 1 — Run `connect` command

```bash
node dist/cli/index.js connect
```

**Expected outcome**:
- `"Connecting to WhatsApp..."` printed
- QR code rendered in terminal via `qrcode-terminal`
- After scanning with WhatsApp mobile: `"✓ Connected to WhatsApp"`
- List of groups printed with JID and name
- Command exits cleanly with code 0

**Expected output format**:
```
Captain Stats - WhatsApp Group Setup
Connecting to WhatsApp...

[QR CODE]

✓ Connected to WhatsApp
Fetching your groups...

Group JID                              Name
──────────────────────────────────────────────────────────────────────
120363123456789012@g.us                Team Alpha Watford
...

Set your authorized group in .env:
  AUTHORIZED_GROUP_ID=<group-jid>
```

### Step 2 — Configure `.env`

Identify the correct group from the list and add to `.env`:
```bash
echo "AUTHORIZED_GROUP_ID=120363123456789012@g.us" >> .env
```

### Step 3 — Verify daemon starts correctly

```bash
TEAM_NAME="My Team" CLUB_URL="https://manvfatfootball.com/club/watford/" \
  node dist/cli/index.js daemon --foreground
```

**Expected outcome**:
- No `AUTHORIZED_GROUP_ID not configured` error
- No second QR scan required (auth state reused from `connect`)
- `"✓ Connected to WhatsApp"` printed
- `"✓ Monitoring group: <jid>"` printed
- Daemon running message appears

### Validation Query

```bash
# Verify auth state is stored in database (not a separate file)
sqlite3 captain-stats.db "SELECT COUNT(*) FROM auth_states;" 
# Expected: > 0 rows (session credentials stored)
```

### Success Criteria
✅ QR code displayed and scannable
✅ Group list printed with JID and group name after authentication
✅ Auth state persisted in database (shared between `connect` and `daemon`)
✅ No second QR scan when daemon starts after `connect`
✅ Daemon starts without `AUTHORIZED_GROUP_ID` error after `.env` is set
✅ `connect` exits cleanly (code 0) after listing groups

### Notes
- This is a **manual-only** test — QR auth is interactive and excluded from the automated suite
- If the QR code expires before scanning, re-run `captain-stats connect`
- The `connect` command is safe to re-run; it will reconnect without a QR scan if session is still valid

---

## Validation Scenario 4: Poll Posting

**Goal**: Verify availability polls are posted to WhatsApp group.

### Prerequisites
- Scenario 3 completed (WhatsApp connected)
- At least one scheduled fixture in database
- Authorized WhatsApp group configured

### Commands
```bash
# Manually post poll for next game
./bin/captain-stats poll

# Or post for specific game
./bin/captain-stats poll <game-id>

# With dry-run to see what would be posted
./bin/captain-stats poll --dry-run
```

### Expected Outcome
- Poll message posted to WhatsApp group
- Poll includes: game date, time, opponent, venue
- Poll has response options (e.g., "Available", "Not available", "Maybe")
- Database updated: `games.poll_posted_at` set to current timestamp
- Exit code: 0

### Expected WhatsApp Message Format
```
🏆 Availability Poll

Next Game:
📅 Saturday, June 15, 2026 at 14:00
⚽ vs Red Devils
📍 Victoria Park

Can you make it?
```

### Success Criteria
✅ Poll posted within 1 second of command
✅ Poll visible in WhatsApp group (manual verification)
✅ Database updated with poll timestamp
✅ Poll ID stored for response tracking
✅ Rate limiting respected (max 5 polls/minute)

---

## Validation Scenario 5: Stat Capture from Messages

**Goal**: Verify natural language stat parsing and capture.

### Prerequisites
- Scenario 3 completed (WhatsApp daemon running)
- At least one game marked as `completed` with active capture window
- Daemon monitoring group in real-time

### Test Messages (send to WhatsApp group)
```
1. "2 goals today, 1 assist, weight down, tracked food"
2. "scored once, weight up"
3. "got 2 assists, tracked my food all week"
4. "great game everyone!" (should NOT capture stats)
```

### Expected Capture Results

**Message 1**:
```json
{
  "goals": 2,
  "assists": 1,
  "weight_direction": "down",
  "food_tracked": true
}
```

**Message 2**:
```json
{
  "goals": 1,
  "assists": 0,
  "weight_direction": "up",
  "food_tracked": false
}
```

**Message 3**:
```json
{
  "goals": 0,
  "assists": 2,
  "weight_direction": "unknown",
  "food_tracked": true
}
```

**Message 4**: No capture (general chat, no stat keywords)

### Verification Commands
```bash
# View captured stats
./bin/captain-stats stats <game-id>

# Or via database query
sqlite3 captain-stats.db "SELECT * FROM stat_records WHERE game_id = '<game-id>';"
```

### Success Criteria
✅ Stats captured correctly from messages 1-3
✅ Message 4 ignored (no false positive)
✅ Stats attributed to correct WhatsApp user
✅ Capture only occurs within 3-day window
✅ Conservative approach: 80%+ accuracy for clear messages
✅ False positive rate: <5%

### Edge Cases to Test
- Message sent outside 3-day window: should NOT capture
- Message edited after sending: update existing record
- Message deleted: retain already-captured stats
- Multiple messages from same user: update existing record

---

## Validation Scenario 6: Stat Viewing & Editing

**Goal**: Verify captain can view and correct stats.

### Prerequisites
- Scenario 5 completed (stats captured)
- At least one game with stat records

### Commands
```bash
# View stats for a game
./bin/captain-stats stats <game-id>

# View in JSON format
./bin/captain-stats stats <game-id> --json

# Edit specific stat
./bin/captain-stats stats <game-id> --set <user-id> goals=3

# Add notes
./bin/captain-stats stats <game-id> --set <user-id> notes="Confirmed by video review"
```

### Expected Output (human-readable)
```
Stats - 2026-06-15 vs Red Devils

Player          Goals  Assists  Weight  Food Tracked  Notes
───────────────────────────────────────────────────────────────
John Smith         2       1     down    yes          -
Mike Jones         1       0     up      yes          Confirmed by video review
```

### Verification
```bash
# Check manually_edited flag set
sqlite3 captain-stats.db \
  "SELECT manually_edited, notes FROM stat_records WHERE user_id = '<user-id>';"
# Expected: manually_edited=1, notes="Confirmed by video review"
```

### Success Criteria
✅ Stats displayed in readable table format
✅ JSON output has correct structure
✅ Edits persisted to database
✅ `manually_edited` flag set to true
✅ Notes field updated
✅ Edit operations complete in <100ms
✅ No data loss or corruption

---

## Validation Scenario 7: Historical Data Access

**Goal**: Verify viewing stats across multiple seasons.

### Prerequisites
- Multiple games in database (at least 2 seasons)
- Stats captured for games in different seasons

### Commands
```bash
# List all seasons
./bin/captain-stats seasons

# View fixtures from previous season
./bin/captain-stats fixtures --season 1

# View stats from historical game
./bin/captain-stats stats <old-game-id>
```

### Expected Output
```
Seasons

Number  Start       End         Games  Current
────────────────────────────────────────────────
   1    2024-09-01  2025-05-30    28   No
   2    2025-09-01  (ongoing)     15   Yes
```

### Success Criteria
✅ All seasons listed with correct data
✅ Historical fixtures accessible
✅ Historical stats intact and viewable
✅ Current season marked correctly
✅ No data loss between seasons
✅ Query performance: <100ms for historical data

---

## Validation Scenario 8: Season Transition

**Goal**: Verify automatic season boundary detection.

### Test Scenario
1. Current season has fixtures up to May 30, 2026
2. New fixtures appear on September 1, 2026 (4+ week gap)
3. System should detect season boundary and create Season 2

### Simulation Commands
```bash
# This scenario is complex to validate without waiting months
# Use integration test with mock data

npm run test:integration -- season-transition.test.ts
```

### Test Logic (in integration test)
1. Create season 1 with fixtures ending May 30
2. Mark all games as completed
3. Trigger sync with mock HTML containing September fixtures
4. Verify: new season created, old season marked `is_current = false`

### Expected Database State
```sql
-- Before transition
SELECT * FROM seasons;
-- season_number=1, is_current=1, end_date=NULL

-- After transition
SELECT * FROM seasons ORDER BY season_number;
-- season_number=1, is_current=0, end_date='2026-05-30'
-- season_number=2, is_current=1, start_date='2026-09-01'
```

### Success Criteria
✅ New season created automatically
✅ Previous season end_date set correctly
✅ Previous season `is_current` set to false
✅ New season `is_current` set to true
✅ No fixtures lost or duplicated
✅ 100% accuracy in season detection

---

## Validation Scenario 9: Error Handling & Recovery

**Goal**: Verify graceful error handling and recovery.

### Test Cases

#### 9.1 Club Website Unavailable
```bash
# Simulate by using invalid club URL
sed -i 's|manvfatfootball.org|invalid-domain.org|' .env
./bin/captain-stats sync
```
**Expected**: Error message to stderr, exit code 1, suggest checking URL

#### 9.2 WhatsApp Connection Lost
```bash
# Simulate by disconnecting network during daemon run
# (manual test)
```
**Expected**: Daemon logs reconnection attempt with exponential backoff, recovers when network returns

#### 9.3 Database Locked
```bash
# Simulate by opening second connection with exclusive lock
# (integration test)
```
**Expected**: Retry with timeout, clear error message if fails

#### 9.4 Invalid Stat Message
```bash
# Send ambiguous message: "think I maybe got 2?"
```
**Expected**: Conservative approach - NOT captured (no clear stat statement)

### Success Criteria
✅ All errors produce clear messages to stderr
✅ Exit codes match documented contract
✅ Daemon recovers from temporary failures
✅ No data corruption on errors
✅ Logs contain sufficient debugging info

---

## Validation Scenario 10: Performance & Scale

**Goal**: Verify performance meets requirements.

### Test Data Setup
```bash
# Generate test data via script
npm run generate-test-data -- \
  --seasons 5 \
  --games-per-season 28 \
  --players 15 \
  --stats-coverage 0.8
```

### Performance Tests
```bash
# Fixture retrieval
time ./bin/captain-stats fixtures
# Expected: <5 seconds

# Historical query
time ./bin/captain-stats stats <old-game-id>
# Expected: <100ms

# Season listing with 5 seasons
time ./bin/captain-stats seasons --json
# Expected: <100ms

# Database size check
du -h captain-stats.db
# Expected: <10MB for 5 seasons
```

### Success Criteria
✅ Fixture retrieval: <5 seconds (SC-001)
✅ Historical queries: <100ms
✅ Database size: <10MB for 5 seasons
✅ Memory usage: <100MB for daemon
✅ No performance degradation with historical data

---

## Continuous Validation

### Automated Test Suite
```bash
# Run all unit tests
npm run test:unit

# Run all integration tests
npm run test:integration

# Run contract tests
npm run test:contract

# Run all tests with coverage
npm run test:coverage
```

### Expected Coverage Targets
- Unit tests: >80% code coverage
- Integration tests: All major workflows
- Contract tests: All CLI commands

### CI/CD Integration
```bash
# In CI pipeline
npm ci
npm run build
npm run lint
npm run test:all
npm run test:coverage -- --threshold 80
```

---

## Troubleshooting

### Common Issues

**Issue**: QR code not scanning
- **Solution**: Ensure QR code is fully visible, try re-running daemon

**Issue**: Fixtures not appearing
- **Solution**: Check club URL is correct, verify website is accessible, check logs for scraping errors

**Issue**: Stats not capturing
- **Solution**: Verify game is within 3-day capture window, check daemon is running, review message format

**Issue**: Database locked error
- **Solution**: Ensure no other processes accessing database, check file permissions

---

## References

- [Data Model](./data-model.md) - Entity definitions and relationships
- [CLI Interface Contract](./contracts/cli-interface.md) - Detailed command reference
- [Research](./research.md) - Technology decisions and rationale

---

## Notes

- This guide focuses on **validation** and **testing** scenarios
- Detailed implementation tasks are in `tasks.md` (generated by `/speckit-tasks`)
- Manual verification required for WhatsApp interactions (QR auth, message visibility)
- Integration tests use mock data to avoid dependency on external services
- Performance targets from spec.md Success Criteria section
