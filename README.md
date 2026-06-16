# Captain Stats

A CLI tool for MAN v FAT Football team captains. It scrapes a club's fixtures, posts WhatsApp
availability polls, captures player stats from group chat, and stores everything per season for
later viewing.

All WhatsApp behaviour runs through the in-repo **WhatsApp Gateway** library
(`src/whatsapp-gateway/`); no application code touches the underlying protocol library directly.

## Requirements

- Node.js 22.x
- A WhatsApp account (for the one-time QR pairing) and one group to monitor

## Setup

```bash
npm install
npm run build
```

Create a `.env`:

```bash
TEAM_NAME="My Team"
CLUB_URL="https://manvfatfootball.com/club/watford/"   # your club page
# AUTHORIZED_GROUP_ID=<id>@g.us      # set this after `connect` (see below)
# DATABASE_PATH=./captain-stats.db   # optional (default shown)
# TIMEZONE=Europe/London             # optional (default shown)
```

Then initialise and pair:

```bash
captain-stats init --team-name "My Team" --club-url https://manvfatfootball.com/club/watford/
captain-stats connect       # scan the terminal QR or open the saved PNG; lists your groups
# copy the target group's id into AUTHORIZED_GROUP_ID in .env
captain-stats daemon        # resumes the same session — no second QR scan
```

## Commands

| Command | What it does |
|---------|--------------|
| `init` | Create the config + database and register the team/season. |
| `fixtures` | View upcoming fixtures, chronologically (`--all`, `--season <n>`, `--json`). |
| `sync` | Re-scrape fixtures on demand; detects season transitions. |
| `connect` | Pair via QR and list group ids so you can set `AUTHORIZED_GROUP_ID` (`--reset`). |
| `daemon` | Long-running monitor: handles `!postpoll`, captures votes and stats. |
| `poll` | Post/replace the next fixture's poll from the CLI (`--dry-run`, `--force`, `--json`). |
| `stats` | View stored stats grouped by player (`--game <id>`, `--season <n>`, `--json`). |
| `seasons` | List season history (`--json`). |

## How it works

- **Fixtures** are scraped from the club page (static HTML — Axios + Cheerio) on demand: when
  `fixtures`/`sync` run and when a poll is triggered. A new season is created automatically when all
  previously scraped fixtures disappear from the site; previous seasons are preserved.
- **Polls** are posted manually, never on a schedule. Any member can post the next fixture's
  availability poll by sending `!postpoll` in the group (or run `poll` from the CLI). Re-triggering
  replaces the existing poll and its votes. Votes are tallied durably in the database against each
  voter's canonical identity, so a person is never double-counted across WhatsApp address forms.
- **Stats** are captured from group messages in the 3 days after a game, conservatively (≥70%
  confidence): goals, assists, weight direction, and food tracking. Later messages from the same
  player merge field-by-field — the only way stored stats change (there is no captain-side editing).

## Development

```bash
npm run dev          # tsx watch on the CLI entry point
npm test             # full Vitest suite (target < 10s)
npm run test:unit
npm run test:integration
npm run build        # tsc
npm run format       # prettier
```

Tests use a real in-memory SQLite database and mock only at service boundaries — a fake fixture
scraper and a fake Gateway (`tests/helpers/`). See `tests/README.md` for the testing philosophy. A
guard test asserts no application code imports the WhatsApp protocol library.

## Specs

This MVP is specified under `specs/003-mvp-attempt-2/` (overview in `plan.md`, behaviour in
`spec.md`, validation in `quickstart.md`). It is built on the WhatsApp Gateway library from
`specs/002-whatsapp-gateway/`.
