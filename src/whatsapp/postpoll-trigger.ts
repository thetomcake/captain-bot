/**
 * `!postpoll` in-chat trigger (T050, FR-029).
 *
 * `isPostPollCommand` recognises the command — a whole-message exact match of `!postpoll`
 * (case-insensitive, trimmed); a message that merely *contains* the words is ordinary chat. The
 * event-router (T035) calls it FIRST and, on a match, routes to {@link createPostPollHandler}'s
 * handler, bypassing stat extraction.
 *
 * The handler runs the shared `postOrReplaceNextPoll()` orchestration (always forcing — a
 * re-trigger replaces, FR-027), stays silent in-chat on success (the posted poll is the
 * confirmation), and replies in the authorized group only on a problem (no confirmed next fixture,
 * or a club-site fetch failure — FR-028). Every outcome is logged (FR-025).
 */
import type { PollService } from '../services/poll-service.js';
import type { IWhatsAppGateway, IncomingMessage } from './gateway-port.js';
import { logger } from '../utils/logger.js';

const POSTPOLL_COMMAND = '!postpoll';

/** Minimum gap between two `!postpoll`-driven posts (T051). Triggers inside it are ignored. */
export const POSTPOLL_MIN_INTERVAL_MS = 5 * 60 * 1000;

const NO_FIXTURE_REPLY = 'No confirmed next fixture yet — nothing to poll.';
const FETCH_FAILED_REPLY = "Couldn't reach the club site to check fixtures — try again shortly.";

/** True iff the whole message is exactly `!postpoll` (case-insensitive, trimmed). */
export function isPostPollCommand(text: string | null | undefined): boolean {
  return (text ?? '').trim().toLowerCase() === POSTPOLL_COMMAND;
}

export interface PostPollHandlerDeps {
  pollService: PollService;
  gateway: IWhatsAppGateway;
  /** The authorized group JID problem-replies are sent to. */
  groupId: string;
  /**
   * Minimum gap between two `!postpoll`-driven posts (T051). A trigger arriving within this window
   * of the last successful post is ignored (silent in-chat — only logged). Defaults to 5 minutes;
   * tests may pass `0` to exercise the post/replace path without the throttle.
   */
  minIntervalMs?: number;
}

/**
 * Build the `!postpoll` handler bound to its dependencies. Returns a function the event-router
 * invokes with the triggering {@link IncomingMessage}.
 */
export function createPostPollHandler(
  deps: PostPollHandlerDeps
): (message: IncomingMessage) => Promise<void> {
  const { pollService, gateway, groupId } = deps;
  const minIntervalMs = deps.minIntervalMs ?? POSTPOLL_MIN_INTERVAL_MS;

  return async function handlePostPoll(message: IncomingMessage): Promise<void> {
    // Throttle (T051): ignore a trigger arriving within `minIntervalMs` of the last posted poll, so
    // a member cannot spam-replace the poll (and its votes). Silent in-chat — only logged.
    if (minIntervalMs > 0) {
      const last = await pollService.getLastPollPostedAt();
      if (last && Date.now() - last.getTime() < minIntervalMs) {
        logger.info('!postpoll ignored — within the throttle window', {
          sender: message.sender.canonicalId,
          lastPostedAt: last.toISOString(),
          minIntervalMs,
        });
        return;
      }
    }

    let result;
    try {
      // A re-trigger force-replaces the prior poll (FR-027/FR-029).
      result = await pollService.postOrReplaceNextPoll({ force: true });
    } catch (error) {
      logger.error('!postpoll handler failed', error instanceof Error ? error : new Error(String(error)), {
        sender: message.sender.canonicalId,
      });
      return;
    }

    switch (result.outcome) {
      case 'posted':
      case 'replaced':
        // Silent in-chat — the posted poll is the confirmation.
        logger.info(`!postpoll ${result.outcome} poll for "${result.fixture.opponent}"`, {
          sender: message.sender.canonicalId,
          pollMessageId: result.ref.id,
        });
        return;
      case 'no-fixture':
        logger.info('!postpoll: no confirmed next fixture — replying in chat (FR-028)');
        await gateway.sendMessage(groupId, NO_FIXTURE_REPLY);
        return;
      case 'fetch-failed':
        logger.warn('!postpoll: club-site fetch failed — replying in chat (FR-028)', {
          error: result.error,
        });
        await gateway.sendMessage(groupId, FETCH_FAILED_REPLY);
        return;
    }
  };
}
