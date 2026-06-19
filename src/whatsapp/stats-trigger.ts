/**
 * `!stats` in-chat trigger.
 *
 * `isStatsCommand` recognises the command — a whole-message exact match of `!stats`
 * (case-insensitive, trimmed); a message that merely *contains* the word is ordinary chat. The
 * event-router calls it before stat extraction and, on a match, routes to {@link createStatsHandler}'s
 * handler so the command is never captured as a stat.
 *
 * The handler reuses `AggregateService.getReport` + `formatReportBlock` and posts the current
 * season's report straight back into the group — the posted report IS the success response. A
 * missing current season or a season with no data posts a "no data" message instead of an empty
 * block. An in-process 5-minute cooldown suppresses repeats; compute/post failures are logged and
 * swallowed, never rethrown.
 */
import type { AggregateService } from '../services/aggregate-service.js';
import type { IWhatsAppGateway, IncomingMessage } from './gateway-port.js';
import { formatReportBlock } from '../cli/output/aggregate-formatters.js';
import { logger } from '../utils/logger.js';

const STATS_COMMAND = '!stats';

/** Minimum gap between two `!stats`-driven posts. Triggers inside it are ignored (silent). */
export const STATS_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Posted when there is no current season, or the current season has no data to report. */
export const NO_DATA_REPLY = 'No stats to report yet for the current season.';

/** True iff the whole message is exactly `!stats` (case-insensitive, trimmed). */
export function isStatsCommand(text: string | null | undefined): boolean {
  return (text ?? '').trim().toLowerCase() === STATS_COMMAND;
}

export interface StatsHandlerDeps {
  aggregateService: AggregateService;
  gateway: IWhatsAppGateway;
  /** The authorized group the report is posted to. */
  groupId: string;
  /**
   * Minimum gap between two `!stats`-driven posts. A trigger arriving within this window of the
   * last post is ignored (silent in-chat — only logged). Defaults to 5 minutes; tests may pass `0`
   * to exercise the post path without the throttle.
   */
  minIntervalMs?: number;
  /** Clock source for the throttle; defaults to `Date.now`. Injected in tests to cross the window. */
  now?: () => number;
}

/**
 * Build the `!stats` handler bound to its dependencies. Returns a function the event-router invokes
 * with the triggering {@link IncomingMessage}. The throttle state (`lastPostedAt`) lives in this
 * closure — not persisted, so it resets on daemon restart (an accepted property).
 */
export function createStatsHandler(
  deps: StatsHandlerDeps
): (message: IncomingMessage) => Promise<void> {
  const { aggregateService, gateway, groupId } = deps;
  const minIntervalMs = deps.minIntervalMs ?? STATS_MIN_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  let lastPostedAt: number | null = null;

  return async function handleStats(message: IncomingMessage): Promise<void> {
    const sender = message.sender.canonicalId;

    // Throttle: ignore a trigger arriving within `minIntervalMs` of the last post. Silent in-chat.
    if (minIntervalMs > 0 && lastPostedAt !== null && now() - lastPostedAt < minIntervalMs) {
      logger.info('!stats throttled — within the cooldown window', { sender, minIntervalMs });
      return;
    }

    try {
      const resolution = await aggregateService.resolveSeason();
      // No current season is surfaced as no-data (the trigger takes no season selector).
      if (resolution.kind === 'not-found') {
        await gateway.sendMessage(groupId, NO_DATA_REPLY);
        lastPostedAt = now();
        logger.info('!stats no-data — no current season', { sender });
        return;
      }

      const report = await aggregateService.getReport(resolution.season.id);
      if (!report.season.hasData) {
        await gateway.sendMessage(groupId, NO_DATA_REPLY);
        lastPostedAt = now();
        logger.info('!stats no-data — current season has no data', {
          sender,
          season: resolution.season.seasonNumber,
        });
        return;
      }

      await gateway.sendMessage(groupId, formatReportBlock(report));
      lastPostedAt = now();
      logger.info('!stats posted season report', {
        sender,
        season: resolution.season.seasonNumber,
      });
    } catch (error) {
      logger.error(
        '!stats handler failed',
        error instanceof Error ? error : new Error(String(error)),
        { sender }
      );
    }
  };
}
