// Public surface of the WhatsApp Gateway library.
//
// INVARIANT (contracts/gateway-interface.md): only the WhatsAppGateway class,
// the domain types, and the pure `aggregateVotes` helper are exported here — NO
// Baileys type ever appears in this surface. Consumers (the MVP later; the manual
// bin/ entry points now) import only from this module.
export { WhatsAppGateway } from './gateway.js';

// Domain types (see data-model.md). `export type` keeps them erasable and ensures
// no runtime/Baileys coupling leaks to consumers.
export type {
  ConnectionStatus,
  WhatsAppCredentials,
  GroupSummary,
  Identity,
  IncomingMessage,
  MessageRef,
  DeleteOutcome,
  PollSpec,
  PollKeyset,
  PollRef,
  PollSendResult,
  PollVote,
  PollOptionResult,
  PollResult,
  ReconnectPolicyConfig,
  Logger,
  GatewayConfig,
} from './types.js';

// TODO(T036, Phase 5): export the pure `aggregateVotes(votes: PollVote[]): PollResult`
// helper here once polls/poll-tally.ts exists. It is part of the contract's public
// surface but is implemented in the US3 phase (test-first), so it is intentionally
// not yet exported.
