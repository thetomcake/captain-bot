# Fixture Scraping Strategy

**Task**: T027 - Verify static scraping can extract all FR-002 required fields

**Source**: https://manvfatfootball.com/club/watford/

**Fixture File**: manvfat-fixtures.html

## FR-002 Required Fields

1. ✅ **Date** - EXTRACTABLE
2. ✅ **Time** - EXTRACTABLE
3. ✅ **Opponent** - EXTRACTABLE  
4. ⚠️ **Venue** - NOT EXPLICIT (use default/optional)

## HTML Structure Analysis

### Week Headers
```html
<div class="group-header white">Week 7 - June 29th</div>
```
**Extraction Strategy**: Parse week header text to extract date (e.g., "June 29th")

### Fixture Table
```html
<table class="fixture-table">
  <tr class="no-highlight">
    <td class="game-week-no">19:00<br>League</td>
    <td class="team-name"><span class="colourbox yellow"></span> yellow team</td>
    <td class="score home">-</td>
    <td class="versus">v</td>
    <td class="score away">-</td>
    <td class="team-name"><span class="colourbox blue"></span> Blue team</td>
  </tr>
</table>
```

### CSS Selectors

| Field | Selector | Example Value |
|-------|----------|---------------|
| Week Date | `.group-header.white` | "Week 7 - June 29th" |
| Time | `td.game-week-no` (first line) | "19:00" |
| Game Type | `td.game-week-no` (second line) | "League" |
| Home Team | First `td.team-name` text | "yellow team" |
| Away Team | Second `td.team-name` text | "Blue team" |
| Score | `td.score` | "-" (upcoming) or "3" (completed) |

### Venue Handling

**Finding**: Venue information is NOT explicitly present in the fixture listings.

**Rationale**: MAN v FAT Football leagues typically play all games at a central venue. The venue is constant for a club and may be listed elsewhere on the club page (not in fixture table).

**Implementation Options**:
1. Extract venue from club page header/info section
2. Use configurable default venue from `.env`
3. Mark as "TBD" or use club name as venue

**Recommendation**: Use club name or generic "Club Venue" as default, make venue optional in schema (already done in research.md)

## Extraction Algorithm

```typescript
function scrapeFixtures(html: string): Fixture[] {
  const $ = cheerio.load(html);
  const fixtures: Fixture[] = [];
  
  // Find all week sections
  $('.group-header.white').each((_, header) => {
    const weekText = $(header).text(); // "Week 7 - June 29th"
    const date = extractDate(weekText); // Parse to get "June 29th"
    
    // Find fixture table in this week's section
    const table = $(header).next('.responsive-table').find('table.fixture-table');
    
    table.find('tr.no-highlight').each((_, row) => {
      const timeCell = $(row).find('td.game-week-no').first();
      if (timeCell.length === 0) return; // Skip header rows
      
      const time = timeCell.html()?.split('<br>')[0].trim(); // "19:00"
      const teamCells = $(row).find('td.team-name');
      
      if (teamCells.length === 2) {
        const homeTeam = $(teamCells[0]).text().trim();
        const awayTeam = $(teamCells[1]).text().trim();
        
        fixtures.push({
          date,
          time,
          opponent: awayTeam, // Assuming we're the home team
          venue: 'Club Venue', // Default venue
          status: 'upcoming'
        });
      }
    });
  });
  
  return fixtures;
}
```

## Edge Cases to Handle

1. **Fixtures to be confirmed**: Some weeks show "Fixtures to be confirmed" instead of actual games
2. **Past games**: May show scores instead of "-"
3. **Multiple games per week**: Week may have multiple fixture rows
4. **Date parsing**: "June 29th" needs to be converted to proper date format with year
5. **Home vs Away**: Need to determine which team is "us" (may require team name matching)

## Verification

✅ HTML fixture file captured successfully (8152 lines)
✅ Fixture tables identified with class="fixture-table"
✅ Week headers contain dates
✅ Time information available in game-week-no cells
✅ Team names extractable from team-name cells
⚠️ Venue requires default handling (not in HTML)

## Next Steps

- T023: Write fixture scraper unit tests based on this strategy
- T024: Write fixture service integration tests
- T025: Write CLI command contract tests
- T028: Implement scraper using this extraction algorithm
