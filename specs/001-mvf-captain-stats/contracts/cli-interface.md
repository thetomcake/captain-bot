# CLI Interface Contract

**Feature**: 001-mvf-captain-stats
**Date**: 2026-06-10

## Overview

This document defines the command-line interface contract for the Captain Stats tool. All commands follow Unix conventions: read from stdin/args, write to stdout, errors to stderr, and return appropriate exit codes.

---

## Global Options

Available for all commands:

- `--json` - Output in JSON format (machine-readable)
- `--config <path>` - Path to config file (default: `.env`)
- `--help`, `-h` - Show help for command
- `--version`, `-v` - Show version information

---

## Commands

### `captain-stats fixtures`

Display upcoming fixtures for the current season.

**Usage**:
```bash
captain-stats fixtures [options]
```

**Options**:
- `--all` - Show all fixtures including completed/cancelled
- `--season <number>` - Show fixtures for specific season (default: current)
- `--json` - Output as JSON

**Output** (human-readable):
```
Upcoming Fixtures - Season 2

Date         Time   Opponent           Venue                Status
─────────────────────────────────────────────────────────────────────
2026-06-15   14:00  Red Devils         Victoria Park        Scheduled
2026-06-22   15:30  Blue Warriors      Central Stadium      Scheduled
2026-06-29   14:00  Green Strikers     Victoria Park        Scheduled
```

**Output** (JSON):
```json
{
  "season": 2,
  "is_current": true,
  "fixtures": [
    {
      "id": "uuid-here",
      "date": "2026-06-15",
      "time": "14:00",
      "opponent": "Red Devils",
      "venue": "Victoria Park",
      "status": "scheduled"
    }
  ]
}
```

**Exit Codes**:
- `0` - Success
- `1` - No fixtures found
- `2` - Invalid season number
- `3` - Database error

---

### `captain-stats daemon`

Run WhatsApp monitoring daemon for real-time message processing and scheduled tasks.

**Usage**:
```bash
captain-stats daemon [options]
```

**Options**:
- `--foreground`, `-f` - Run in foreground (default: background)
- `--log <path>` - Log file path (default: `captain-stats.log`)

**Behavior**:
- Connects to WhatsApp via QR code on first run
- Monitors authorized group for messages
- Posts availability polls automatically (day after each game)
- Captures stats from messages within 3-day windows
- Logs all activities to log file

**Output**:
```
Captain Stats Daemon v1.0.0
Connecting to WhatsApp...
Scan QR code with WhatsApp mobile app:
[QR CODE DISPLAYED]

✓ Connected to WhatsApp
✓ Monitoring group: Team Alpha
✓ Current season: 2
✓ Next game: 2026-06-15 vs Red Devils

Daemon running. Press Ctrl+C to stop.
```

**Exit Codes**:
- `0` - Clean shutdown
- `1` - WhatsApp connection failed
- `2` - Configuration error (missing group ID, etc.)
- `3` - Database error

**Signals**:
- `SIGINT`, `SIGTERM` - Graceful shutdown (save state, disconnect)

---

### `captain-stats stats <game-id>`

View or edit stats for a specific game.

**Usage**:
```bash
captain-stats stats <game-id> [options]
```

**Options**:
- `--edit` - Enter interactive edit mode
- `--set <user-id> <field>=<value>` - Set specific stat value
- `--json` - Output as JSON
- `--season <number>` - Filter by season for game selection

**Output** (human-readable):
```
Stats - 2026-06-15 vs Red Devils

Player          Goals  Assists  Weight  Food Tracked  Notes
───────────────────────────────────────────────────────────────
John Smith         2       1     down    yes          -
Mike Jones         1       0     up      yes          -
Sarah Lee          0       2     down    no           -
Tom Brown          0       0     unknown no           Not played
```

**Output** (JSON):
```json
{
  "game": {
    "id": "uuid-here",
    "date": "2026-06-15",
    "opponent": "Red Devils",
    "venue": "Victoria Park"
  },
  "stats": [
    {
      "user": {
        "id": "uuid-here",
        "display_name": "John Smith"
      },
      "goals": 2,
      "assists": 1,
      "weight_direction": "down",
      "food_tracked": true,
      "manually_edited": false,
      "notes": null
    }
  ]
}
```

**Edit Mode**:
```bash
captain-stats stats game-uuid --edit
```
Interactive prompt for editing each player's stats.

**Direct Edit**:
```bash
captain-stats stats game-uuid --set user-uuid goals=3
captain-stats stats game-uuid --set user-uuid notes="Captain confirmed"
```

**Exit Codes**:
- `0` - Success
- `1` - Game not found
- `2` - Invalid field or value
- `3` - Database error

---

### `captain-stats poll [game-id]`

Post availability poll for next game or specific game.

**Usage**:
```bash
captain-stats poll [game-id] [options]
```

**Options**:
- `--force` - Replace existing poll (delete the prior poll, its responses, and the WhatsApp message, then repost)
- `--dry-run` - Show what would be posted without actually posting

**Behavior**:
- If no `game-id`: posts poll for next scheduled game
- If `game-id` provided: posts poll for that specific game
- Checks if poll already posted (skip unless `--force`)
- With `--force`: hard-deletes the existing poll and cascade-deletes its responses, posts exactly one new poll, and best-effort deletes the old WhatsApp poll message (a deletion failure logs a warning but still completes the replacement). A game never has more than one poll row (FR-024).

**Output**:
```
Posting availability poll...

Game: 2026-06-15 14:00 vs Red Devils at Victoria Park
✓ Poll posted to WhatsApp group
✓ Poll ID: msg-uuid-here

Players can now respond with their availability.
```

**Exit Codes**:
- `0` - Success
- `1` - No upcoming games
- `2` - Poll already posted (without --force)
- `3` - WhatsApp connection error
- `4` - Database error

---

### `captain-stats seasons`

List all seasons with summary statistics.

**Usage**:
```bash
captain-stats seasons [options]
```

**Options**:
- `--json` - Output as JSON

**Output** (human-readable):
```
Seasons

Number  Start       End         Games  Current
────────────────────────────────────────────────
   1    2024-09-01  2025-05-30    28   No
   2    2025-09-01  (ongoing)     15   Yes
```

**Output** (JSON):
```json
{
  "seasons": [
    {
      "season_number": 1,
      "start_date": "2024-09-01",
      "end_date": "2025-05-30",
      "games_count": 28,
      "is_current": false
    },
    {
      "season_number": 2,
      "start_date": "2025-09-01",
      "end_date": null,
      "games_count": 15,
      "is_current": true
    }
  ]
}
```

**Exit Codes**:
- `0` - Success
- `3` - Database error

---

### `captain-stats sync`

Manually trigger fixture sync from club website.

**Usage**:
```bash
captain-stats sync [options]
```

**Options**:
- `--force` - Sync even if recently synced

**Output**:
```
Syncing fixtures from manvfatfootball.org/club/watford...

✓ Found 12 fixtures
✓ 2 new fixtures added
✓ 1 fixture updated (time changed)
✓ 0 fixtures removed

Last sync: 2026-06-10 14:30
```

**Exit Codes**:
- `0` - Success
- `1` - Club website unavailable
- `2` - Scraping error (HTML structure changed)
- `3` - Database error

---

### `captain-stats connect`

Connect to WhatsApp, display QR code for scanning, then list all available groups with their JIDs so the operator can configure `AUTHORIZED_GROUP_ID`.

**Usage**:
```bash
captain-stats connect
```

**Options**: None

**Behavior**:
1. Connects to WhatsApp using Baileys (database-backed auth state, shared with daemon)
2. If no existing session: displays QR code for the operator to scan with their phone
3. If existing session: reconnects automatically without a QR scan
4. After connection: calls `groupFetchAllParticipating()` and prints all groups
5. Exits cleanly after listing

**Output**:
```
Captain Stats - WhatsApp Group Setup
Connecting to WhatsApp...

Scan this QR code with WhatsApp:
[QR CODE DISPLAYED]

✓ Connected to WhatsApp
Fetching your groups...

Group JID                              Name
──────────────────────────────────────────────────────────────────────
120363123456789012@g.us                Team Alpha Watford
120363987654321098@g.us                Friends Football
120363111222333444@g.us                Work 5-a-side

Set your authorized group in .env:
  AUTHORIZED_GROUP_ID=<group-jid>
```

**Exit Codes**:
- `0` - Success (groups listed)
- `2` - Configuration error (no team initialized — run `init` first)
- `3` - Database error
- `4` - WhatsApp connection error

**Notes**:
- Run this command **before** `captain-stats daemon` on first setup
- Auth state is shared with the daemon — no second QR scan required when starting the daemon
- If the QR code is not scanned within Baileys' timeout window, the command exits with code 4 and can be re-run

---

### `captain-stats init`

Initialize configuration and database.

**Usage**:
```bash
captain-stats init [options]
```

**Options**:
- `--club-url <url>` - MAN v FAT club page URL
- `--team <name>` - Team identifier
- `--interactive`, `-i` - Interactive setup wizard (default)

**Behavior**:
- Creates `.env` file if not exists
- Prompts for club URL, team identifier
- Initializes SQLite database
- Runs migrations
- Creates first season

**Output**:
```
Captain Stats Setup

Club URL: https://manvfatfootball.org/club/watford/
Team: Team Alpha

✓ Configuration saved to .env
✓ Database initialized at ./captain-stats.db
✓ Migrations applied (1 pending)
✓ Season 1 created

Setup complete! Run 'captain-stats sync' to fetch fixtures.
```

**Exit Codes**:
- `0` - Success
- `1` - Invalid club URL
- `2` - Configuration error
- `3` - Database error

---

## Exit Code Summary

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | Command-specific error (not found, validation, etc.) |
| `2`  | Configuration or input error |
| `3`  | Database error |
| `4`  | External service error (WhatsApp, website) |

---

## Environment Variables

Required configuration via `.env` file or environment:

```bash
# Club & Team
CLUB_URL=https://manvfatfootball.org/club/watford/
TEAM_IDENTIFIER=team-alpha

# WhatsApp
WHATSAPP_GROUP_JID=1234567890-1234567890@g.us

# Database
DATABASE_PATH=./captain-stats.db
# Alternative: DATABASE_URL=postgresql://user:pass@host/db

# Scheduling
POLL_POST_HOUR=9              # 9am
STAT_CAPTURE_DAYS=3           # 3 days after game
FIXTURE_SYNC_INTERVAL=86400   # 24 hours in seconds

# Timezone
TZ=Europe/London
```

---

## Standard Streams

### stdin
- Interactive prompts (edit mode, init wizard)
- Piped input not currently supported but may be added for batch operations

### stdout
- Primary output (tables, JSON)
- Human-readable by default
- Machine-readable with `--json`

### stderr
- Error messages
- Warning messages
- Progress indicators (when not `--json`)

---

## Output Formats

### Human-Readable (Default)
- ASCII tables with Unicode box-drawing characters
- Color support (respects `NO_COLOR` environment variable)
- Progress indicators for long operations

### JSON (--json flag)
- Valid JSON objects/arrays
- Consistent structure across commands
- Error messages also as JSON:
  ```json
  {
    "error": "Game not found",
    "code": 1,
    "details": "No game found with ID: game-uuid"
  }
  ```

---

## Configuration File

### .env format
Simple key=value pairs as shown in Environment Variables section.

### Future: YAML/JSON support
May add support for `captain-stats.yaml` or `captain-stats.json` for complex configuration.

---

## Composability Examples

### Scripting with JSON output:
```bash
# Get next fixture date
captain-stats fixtures --json | jq -r '.fixtures[0].date'

# Count total goals by player across season
captain-stats stats --all --season 2 --json | \
  jq '[.stats[].goals] | add'

# Export all data for backup
captain-stats seasons --json > backup.json
```

### Cron scheduling:
```bash
# Sync fixtures daily at 3am
0 3 * * * captain-stats sync

# Run daemon (systemd service recommended for production)
```

---

## Error Handling

### User Errors (Exit 1-2)
- Clear error message to stderr
- Suggest corrective action
- Include command help hint

**Example**:
```
Error: Game not found with ID: invalid-uuid

Use 'captain-stats fixtures' to see available games.
Run 'captain-stats stats --help' for more information.
```

### System Errors (Exit 3-4)
- Technical error details to stderr
- Suggest troubleshooting steps
- Include log file location if applicable

**Example**:
```
Error: Failed to connect to WhatsApp

Possible causes:
  - Network connectivity issue
  - WhatsApp servers unreachable
  - Session expired (re-authentication needed)

Check logs at: ./captain-stats.log
Run 'captain-stats daemon' to re-authenticate.
```

---

## Versioning

### Command Compatibility
- Minor version changes: backward-compatible additions
- Major version changes: may include breaking CLI changes
- Output format changes documented in CHANGELOG

### Deprecation Policy
- Deprecated commands/flags warned for 2 minor versions
- Removed in next major version
- Alternative documented in deprecation warning

---

## Security Considerations

### Sensitive Data
- Never output WhatsApp auth keys
- Redact phone numbers in human-readable output
- JSON output may include full data (use with caution)

### File Permissions
- Database file: readable/writable by owner only (chmod 600)
- Config file: readable by owner only (chmod 400)
- Auth state directory: owner only (chmod 700)

### Audit Trail
- All manual edits logged with timestamp and command
- Daemon activities logged (polls posted, stats captured)
- Log file rotation recommended for long-running deployments

---

## Future Extensions

### Planned Commands (not in MVP):
- `captain-stats report` - Generate season summary reports
- `captain-stats export` - Export data to CSV/Excel
- `captain-stats players` - List all players with aggregate stats
- `captain-stats config` - Manage configuration via CLI

### Planned Options:
- `--quiet`, `-q` - Suppress non-error output
- `--verbose`, `-v` - Detailed output with debug info
- `--no-color` - Disable color output
