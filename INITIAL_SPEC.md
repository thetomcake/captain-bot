# MAN v FAT Captain Stats Tool — Specification

**Type:** Spec-driven development specification (the *what*, not the *how*). Personal project.
**Scope:** Bare minimum.

---

## Purpose

For a MAN v FAT captain: automatically pull the team's fixtures, post an availability poll after each game, read the team's WhatsApp messages to capture each player's stats, and keep a historic record per season.

---

## Functional requirements

### Clubs & fixtures
- **FR-01** The system MUST support any MAN v FAT club, identified by its club page on `manvfatfootball.com` (e.g. `manvfatfootball.com/club/watford/`), and the captain's team within that club.
- **FR-02** The system MUST obtain that team's fixtures from the club page, including date, time, opponent, and venue.
- **FR-03** The system MUST recheck fixtures regularly and reflect changes, since fixtures can be moved, rescheduled, or cancelled.

### Seasons
- **FR-04** The system MUST retain historic data across seasons.
- **FR-05** The system MUST treat the last game listed for a season as the end of that season; when fixtures reset to a new set the following week, it MUST start a new season and keep the previous season's data intact.

### Group monitoring
- **FR-06** The system MUST monitor exactly one explicitly-authorised WhatsApp group, and MUST NOT read any other group or chat.

### Polls
- **FR-07** The system MUST post an availability poll for the next fixture the day after each game (e.g. a Monday game → poll on Tuesday).
- **FR-08** The system MUST record each WhatsApp user's poll response.

### Stat capture (natural language)
- **FR-09** The system MUST interpret natural-language messages in the group to capture, per player: goals, assists, weight direction (`up`/`down`/`unknown`), and food tracking (`yes`/`no`).
- **FR-10** Goals and assists MAY be expressed in different ways, and the system MUST handle those variations.
- **FR-11** The system MUST attempt stat capture only during the 3 days following a game; outside that window messages are treated as ordinary chat.
- **FR-12** The system MUST be conservative: it captures stats only when a message clearly contains them, and MUST NOT over-interpret general chat.
- **FR-13** The system MUST attribute captured stats to the WhatsApp user who sent the message, for the relevant game.
- **FR-14** When a value is not stated, the system MUST assume: goals `0`, assists `0`, weight `unknown`, tracking `no`.
- **FR-15** Weight is direction only (`up`/`down`/`unknown`); the system MUST NOT capture weight values, BMI, or any other health data.

### Recording
- **FR-16** The system MUST store captured stats and poll responses in a database, retained per season.
- **FR-17** The captain MUST be able to view and correct recorded stats, including for past seasons.

---

## Key entities

- **Club / Team** — the MAN v FAT club (its `manvfatfootball.com` page) and the captain's team within it.
- **Season** — a numbered season; historic seasons are retained.
- **Game** — a fixture for the team: date, time, opponent, venue.
- **WhatsApp user** — the player that stats and poll responses are attributed to.
- **Poll / response** — the availability poll for a fixture and each user's answer.
- **Stat record** — per WhatsApp user, per game: goals, assists, weight (`up`/`down`/`unknown`), tracking (`yes`/`no`).

---

## Constraints

- Monitors exactly one authorised WhatsApp group; no other chats are read.
- No consent or account mechanism (personal project).
- Stat capture is intentionally cautious — better to miss a stat than to invent one from chat.