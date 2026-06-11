# Feature Specification: MAN v FAT Captain Stats Tool

**Feature Branch**: `001-mvf-captain-stats`

**Created**: 2026-06-10

**Status**: Draft

**Input**: User description: "read INITIAL_SPEC.md"

## Clarifications

### Session 2026-06-10

- Q: WhatsApp Authentication Process - how should the system authenticate with WhatsApp Web API (Baileys)? → A: QR code scan on first run, database-backed session storage for persistence
- Q: Node.js Runtime Version - which Node.js version should be targeted given Node.js 18 is EOL? → A: Node.js 22.x (Current release)
- Q: Season Transition Detection Algorithm - what specific criteria should trigger creation of a new season? → A: if all old dates disappear
- Q: Fixture Update Frequency - how often should the system automatically recheck fixtures from the club website? → A: Daily checks at 6 AM UK time + manual refresh command
- Q: Stat Parsing Confidence Threshold - what criteria determine if a message is "clear" enough to capture stats? → A: Use confidence scoring (0-100%) with 70% threshold

### Session 2026-06-11

- Q: Should the MVP include both static (Axios+Cheerio) and dynamic (Playwright) web scraping, or start with static only? → A: Start with static scraping only (Axios+Cheerio), add Playwright later if needed
- Q: What happens when the club website is unavailable during the daily 6 AM check? → A: Skip the check, retry at the next scheduled check 24 hours later
- Q: Who can run the tool - is it captain-only, or can players also install it? → A: Single server deployment using the operator's WhatsApp credentials; "captain" means the person running the tool (the admin/operator)
- Q: What level of logging is needed for the daemon? → A: Verbose logging with timestamps for all operations (polls posted, messages processed, fixtures checked, errors) for full audit trail
- Q: How should the system handle fixtures that are rescheduled after a poll has been posted? → A: Post new poll automatically with updated fixture details, mark old poll as superseded

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Team Fixtures (Priority: P1)

As a team captain, I need to see my team's upcoming fixtures so I can plan ahead and know when to post availability polls.

**Why this priority**: This is foundational - without fixture information, no other functionality (polls, stats) can work. This is the entry point for all other features.

**Independent Test**: Can be fully tested by providing a club URL and team identifier, then verifying that all fixtures are retrieved with correct date, time, opponent, and venue details. Delivers immediate value by consolidating fixture information.

**Acceptance Scenarios**:

1. **Given** I provide my club URL (e.g., `manvfatfootball.com/club/watford/`) and team identifier, **When** the system fetches fixtures, **Then** I see all upcoming games with date, time, opponent, and venue
2. **Given** fixtures exist on the club website, **When** I view the fixture list, **Then** I see them ordered chronologically
3. **Given** fixtures have been updated on the club website, **When** the system rechecks, **Then** I see the updated information reflected

---

### User Story 2 - Post Availability Polls (Priority: P2)

As a team captain, I need to automatically post availability polls to WhatsApp after each game so I can quickly gauge who's available for the next fixture without manual coordination.

**Why this priority**: This addresses a repetitive manual task that captains perform after every game. It depends on fixture data (P1) but is independently valuable for team coordination.

**Independent Test**: Can be fully tested by simulating a completed game and verifying that a poll is posted to WhatsApp the following day with the correct fixture details. Delivers value by automating weekly captain duties.

**Acceptance Scenarios**:

1. **Given** a game was played on Monday, **When** Tuesday arrives, **Then** an availability poll for the next fixture is posted to the WhatsApp group
2. **Given** a poll has been posted, **When** players respond, **Then** their responses are recorded with their WhatsApp user identity
3. **Given** multiple fixtures exist, **When** a poll is posted, **Then** it references the correct next fixture

---

### User Story 3 - Capture Player Stats from Chat (Priority: P3)

As a team captain, I need player stats (goals, assists, weight direction, food tracking) to be automatically captured from WhatsApp messages in the 3 days after a game so I don't have to manually track and enter them.

**Why this priority**: This provides automation value but is less critical than seeing fixtures and coordinating availability. Players can still manually report stats if needed.

**Independent Test**: Can be fully tested by sending test messages with various stat formats during the 3-day window after a game and verifying correct capture and attribution. Delivers value by eliminating manual stat entry.

**Acceptance Scenarios**:

1. **Given** a game was played and it's within 3 days, **When** a player messages "2 goals, 1 assist, weight down, tracked food", **Then** stats are captured: goals=2, assists=1, weight=down, tracking=yes
2. **Given** a player messages "scored today" within 3 days of a game, **When** the system processes the message, **Then** 1 goal is attributed to that player for that game
3. **Given** it's been 4 days since the last game, **When** a player mentions goals, **Then** the message is treated as regular chat and not captured as stats
4. **Given** a player messages general chat like "great game everyone", **When** the system processes it, **Then** no stats are captured (conservative approach)
5. **Given** a player doesn't mention a stat component, **When** the system processes their message, **Then** defaults are applied: goals=0, assists=0, weight=unknown, tracking=no

---

### User Story 4 - View and Correct Historical Stats (Priority: P4)

As a team captain, I need to view stats for any game this season or from previous seasons and be able to correct any errors so I maintain accurate records over time.

**Why this priority**: This is important for data integrity but less urgent than core automation features. It can be implemented after basic capture is working.

**Independent Test**: Can be fully tested by viewing stored stats, making corrections, and verifying persistence across sessions. Delivers value by enabling data quality maintenance.

**Acceptance Scenarios**:

1. **Given** stats have been captured for a game, **When** I view that game's stats, **Then** I see all captured data organized by player
2. **Given** I notice an error in captured stats, **When** I edit the values, **Then** the corrected stats are saved
3. **Given** multiple seasons exist, **When** I select a previous season, **Then** I can view all games and stats from that season

---

### User Story 5 - Season Transition (Priority: P5)

As a team captain, I need the system to automatically recognize when a new season starts so historical data is preserved and new data doesn't overwrite previous seasons.

**Why this priority**: This is critical for long-term data integrity but doesn't need to be implemented until season boundaries are actually encountered in production use.

**Independent Test**: Can be fully tested by simulating a season-end scenario where the last fixture completes and new fixtures appear, verifying that a new season is created while preserving the old one.

**Acceptance Scenarios**:

1. **Given** the last game of a season has been played and new fixtures appear, **When** the system detects the change, **Then** a new season is created and previous season data remains intact
2. **Given** multiple seasons exist, **When** I view historical data, **Then** I can distinguish between seasons and access data from any season

---

### Edge Cases

- When the club website is unavailable during the daily 6 AM check, the system skips the check and retries at the next scheduled check 24 hours later (captain can trigger manual refresh if urgent)
- When a fixture is rescheduled after a poll has been posted, the system automatically posts a new poll with updated fixture details and marks the old poll as superseded
- What happens when a player edits or deletes a WhatsApp message containing stats?
- How does the system handle ambiguous stat messages like "think I got 2" or "maybe assisted"?
- What happens when multiple players claim the same goal?
- How does the system handle players who leave the team mid-season?
- What happens when the WhatsApp group becomes temporarily unavailable?
- How does the system handle timezone differences between fixture times and poll posting?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support any MAN v FAT club identified by its club page URL on `manvfatfootball.com` (e.g., `manvfatfootball.com/club/watford/`) and the captain's team within that club
- **FR-002**: System MUST retrieve team fixtures from the club page including date, time, opponent, and venue
- **FR-003**: System MUST automatically recheck fixtures daily at 6 AM UK time and reflect changes, as fixtures can be moved, rescheduled, or cancelled; captain MUST be able to trigger manual refresh on demand
- **FR-004**: System MUST retain historic data across multiple seasons
- **FR-005**: System MUST detect season transitions when previously scraped fixtures are no longer present on the club website, automatically creating a new season while preserving previous season data
- **FR-006**: System MUST authenticate with WhatsApp Web API using QR code scan on first run, with session credentials stored in database (scoped by team and season) to avoid re-authentication on subsequent runs
- **FR-007**: System MUST monitor exactly one explicitly-authorized WhatsApp group and MUST NOT access any other group or chat
- **FR-008**: System MUST post an availability poll for the next fixture on the day after each game (e.g., Monday game → Tuesday poll)
- **FR-009**: System MUST record each WhatsApp user's poll response
- **FR-010**: System MUST interpret natural-language messages to capture per-player stats: goals, assists, weight direction (`up`/`down`/`same`/`unknown`), and food tracking (`yes`/`no`)
- **FR-011**: System MUST handle various natural-language expressions for goals and assists (e.g., "scored", "2 goals", "got one", "assisted")
- **FR-012**: System MUST attempt stat capture only during the 3-day window following a game; messages outside this window are treated as ordinary chat
- **FR-013**: System MUST be conservative in stat capture, using confidence scoring (0-100%) and only capturing stats when confidence exceeds 70%, and MUST NOT over-interpret general chat
- **FR-014**: System MUST attribute captured stats to the WhatsApp user who sent the message, linked to the relevant game
- **FR-015**: System MUST apply defaults when values are not explicitly stated: goals=0, assists=0, weight=unknown, tracking=no
- **FR-016**: System MUST capture weight as direction only (`up`/`down`/`same`/`unknown`) and MUST NOT capture weight values, BMI, or other health data
- **FR-017**: System MUST store captured stats and poll responses in a database, retained per season
- **FR-018**: Captain MUST be able to view recorded stats for any game in current or previous seasons
- **FR-019**: Captain MUST be able to correct recorded stats, including for past seasons
- **FR-020**: System MUST log all operations with timestamps (fixture checks, polls posted, messages processed, errors) to provide full audit trail for debugging and monitoring
- **FR-021**: System MUST detect when a fixture has been rescheduled (date/time/venue changed) after a poll has been posted, automatically post a new poll with updated fixture details, and mark the old poll as superseded

### Key Entities

- **Club/Team**: The MAN v FAT club (identified by its `manvfatfootball.com` page URL) and the specific team the captain manages within that club
- **Season**: A numbered season representing a distinct competition period; historic seasons are retained indefinitely
- **Game**: A fixture for the team including: date, time, opponent, venue, and link to the season
- **WhatsApp User**: The player identity used for attributing stats and poll responses
- **Poll**: An availability poll posted for a specific fixture
- **Poll Response**: A user's answer to a specific poll
- **Stat Record**: Per WhatsApp user, per game: goals (integer), assists (integer), weight direction (`up`/`down`/`same`/`unknown`), food tracking (`yes`/`no`)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Captain can view all team fixtures for the current season within 5 seconds of requesting them
- **SC-002**: Availability polls are posted to WhatsApp within 1 hour of the scheduled post time (day after each game)
- **SC-003**: 80% of clear stat messages (confidence >70%) are correctly captured during the 3-day window
- **SC-004**: False positive rate for stat capture is below 5% (confidence scoring prevents casual chat misinterpretation)
- **SC-005**: Captain can view and correct stats for any game in under 30 seconds
- **SC-006**: Season transitions are detected automatically when old fixtures disappear from club website, with 100% accuracy (no data loss or cross-season contamination)
- **SC-007**: System maintains 99.9% data integrity across multiple seasons (no loss of historical stats or poll responses)
- **SC-008**: Poll response capture rate is 100% (every response is recorded)
- **SC-009**: System reduces captain's manual stat tracking time by at least 70% compared to manual spreadsheet entry

## Assumptions

- The MAN v FAT Football website structure remains consistent enough to scrape fixture information reliably with static HTML parsing using Axios + Cheerio (no JavaScript rendering required; Playwright-based dynamic scraping is explicitly excluded from MVP per 2026-06-11 clarification and will be evaluated for future releases only if static scraping proves insufficient)
- WhatsApp Web API (Baileys library) provides stable QR code authentication with persistent encrypted session support
- The tool runs on a server as a single deployment instance using the operator's (captain's) WhatsApp credentials; operator has physical access to their phone for initial QR code scan authentication
- Players use the authorized WhatsApp group for team communication and stat reporting
- The team plays on a regular weekly schedule with predictable fixture patterns
- Internet connectivity is generally available for periodic fixture checks and WhatsApp monitoring
- The captain has authorization to monitor the WhatsApp group and collect player stats (no consent mechanism needed for this personal project)
- Weight direction data is sufficient; actual weight values or BMI are not needed
- Stat capture accuracy of 80% is acceptable given the conservative approach (70% confidence threshold) and manual correction capability
- Natural language processing can distinguish between stat reports and casual chat with reasonable accuracy using confidence scoring
- Fixture data on the club website is accurate and updated by the league administrators
- Daily fixture checks at 6 AM UK time are sufficient for detecting changes; urgent rescheduling is handled via manual refresh
- The 3-day post-game window is sufficient for players to report their stats
- Poll posting on the day after a game aligns with typical team coordination timelines
- Database storage can scale to handle multiple seasons of data for a single team (estimated: 20-30 games per season, 10-15 players per team, 5+ seasons)
- The captain uses the system regularly enough to catch and correct any stat capture errors
- Timezone handling can default to UK time since MAN v FAT Football is UK-based
