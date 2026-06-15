/**
 * Event router (T035, US3) — reworks the deleted Baileys-bound `message-handler.ts`.
 *
 * Subscribes the MVP's handlers to the Gateway's event surface and enforces the one routing
 * invariant that matters for correctness: on every inbound message, the `!postpoll` command
 * (FR-029) is checked **first** and, on a match, routed to the poll handler — returning before any
 * stat parsing so the command is never mis-captured as a stat (FR-015). Every other message goes
 * to stat capture (T034), which applies its own confidence + 3-day-window gates. Poll votes are
 * folded into the durable tally (T028).
 *
 * The daemon (T045) is the production caller; tests wire it over `FakeGateway`.
 */
import type { IWhatsAppGateway, IncomingMessage } from './gateway-port.js';
import type { StatService } from '../services/stat-service.js';
import type { PollService } from '../services/poll-service.js';
import { isPostPollCommand } from './postpoll-trigger.js';
import { logger } from '../utils/logger.js';

export interface EventRouterDeps {
  gateway: IWhatsAppGateway;
  statService: StatService;
  pollService: PollService;
  /** The bound `!postpoll` handler from {@link createPostPollHandler}. */
  handlePostPoll: (message: IncomingMessage) => void | Promise<void>;
}

/**
 * Wire `onMessage`/`onPollVote` on the gateway. Idempotent per gateway instance is NOT guaranteed
 * — call once during daemon startup.
 */
export function registerEventRouter(deps: EventRouterDeps): void {
  const { gateway, statService, pollService, handlePostPoll } = deps;

  gateway.onMessage(async (message) => {
    try {
      // FR-029: the command is intercepted before stat extraction so it is never captured.
      if (isPostPollCommand(message.text)) {
        await handlePostPoll(message);
        return;
      }
      await statService.captureFromMessage(message);
    } catch (error) {
      logger.error(
        'Event router failed handling a message',
        error instanceof Error ? error : new Error(String(error)),
        { sender: message.sender.canonicalId }
      );
    }
  });

  gateway.onPollVote(async (vote) => {
    try {
      await pollService.handlePollVote(vote);
    } catch (error) {
      logger.error(
        'Event router failed handling a poll vote',
        error instanceof Error ? error : new Error(String(error)),
        { pollId: vote.pollId }
      );
    }
  });
}
