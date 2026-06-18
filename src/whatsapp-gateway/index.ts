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
  PinOutcome,
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

// The pure, stateless consumer-side aggregation helper (US3). The library keeps no
// durable tally — it emits per-voter PollVote deltas; this folds them into a per-option
// PollResult (last-write-per-voter, LID/PN-canonical). No Baileys type appears in it.
export { aggregateVotes } from './polls/poll-tally.js';
