import { getDatabase } from '../../database/client.js';
import { SeasonService } from '../../services/season-service.js';

export interface EndOfSeasonOptions {
  /** Skip the interactive confirmation (non-interactive/scripted use). */
  yes?: boolean;
  /** Alias for {@link EndOfSeasonOptions.yes}. */
  force?: boolean;
  /** Machine-readable result on stdout. */
  json?: boolean;
}

export interface EndOfSeasonDeps {
  /**
   * Confirmation prompt, injected so the command is testable without a TTY (contract
   * cli-end-of-season.md). Defaults to a stdin y/N read; bypassed entirely by `--yes`/`--force`.
   */
  confirm?: () => Promise<boolean>;
}

/** Single-operator team id (mirrors the other CLI commands). */
const TEAM_ID = 1;

/**
 * `end-of-season` command (T017, US4 — FR-010/FR-013, contract cli-end-of-season.md) — the manual
 * season rollover that replaces the retired automatic transition detector (FR-011).
 *
 * Resolves the current season; with none it reports a safe no-op and exits `0` (FR-013, AS5/AS6).
 * Otherwise it confirms (default No) unless `--yes`/`--force` is given, then calls
 * `SeasonService.endSeason` (marking `is_current = false`, stamping `end_date`; games/stats are
 * preserved). It does NOT create the next season — the next fixture fetch lazily creates it via
 * `getOrCreateCurrentSeason` (FR-012).
 *
 * Exit codes (contract): `0` season ended / no current season / declined · `1` runtime/DB error.
 */
export async function endOfSeasonCommand(
  options: EndOfSeasonOptions = {},
  deps: EndOfSeasonDeps = {}
): Promise<void> {
  try {
    const { db } = getDatabase();
    const seasonService = new SeasonService(db);

    const season = await seasonService.getCurrentSeason(TEAM_ID);
    if (!season) {
      if (options.json) {
        console.log(JSON.stringify({ ended: false, reason: 'no-current-season' }));
      } else {
        console.log('No active season to end.');
      }
      process.exit(0);
      return;
    }

    const skipPrompt = options.yes || options.force;
    if (!skipPrompt) {
      const confirm = deps.confirm ?? defaultConfirm(season.seasonNumber);
      const proceed = await confirm();
      if (!proceed) {
        if (options.json) {
          console.log(JSON.stringify({ ended: false, reason: 'cancelled' }));
        } else {
          console.log(`Cancelled — season ${season.seasonNumber} left unchanged.`);
        }
        process.exit(0);
        return;
      }
    }

    const endDate = new Date();
    await seasonService.endSeason(season.id, endDate);

    if (options.json) {
      console.log(
        JSON.stringify({
          ended: true,
          seasonNumber: season.seasonNumber,
          endDate: endDate.toISOString(),
        })
      );
    } else {
      console.log(
        `✓ Season ${season.seasonNumber} ended (${endDate.toISOString().slice(0, 10)}). ` +
          `Next fetch will start season ${season.seasonNumber + 1}.`
      );
    }
    process.exit(0);
  } catch (error) {
    if (options.json) {
      console.log(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      );
    } else {
      console.error('Error:', error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
}

/**
 * Default confirmation: print the season about to end and read a single y/N line from stdin
 * (default No). Replaced by an injected `confirm` in tests; never reached on the `--yes`/`--force`
 * path.
 */
function defaultConfirm(seasonNumber: number): () => Promise<boolean> {
  return () =>
    new Promise((resolveConfirm) => {
      process.stdout.write(
        `End season ${seasonNumber}? Games and stats are preserved. This cannot be undone. [y/N]: `
      );
      process.stdin.resume();
      process.stdin.once('data', (data) => {
        process.stdin.pause();
        const answer = data.toString().trim().toLowerCase();
        resolveConfirm(answer === 'y' || answer === 'yes');
      });
    });
}
