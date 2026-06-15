// PURE, stateless consumer-side aggregation helper (FR-022/FR-023/FR-026).
//
// The library keeps NO durable tally — it emits per-voter `PollVote` deltas (each the
// voter's full current selection; `[]` = withdrawal) and the consumer folds them into a
// running result. `aggregateVotes` is that fold, exported for consumer convenience.
//
// Rules:
//   • last-write-per-voter — a voter's latest selection replaces any earlier one;
//   • withdrawal ([]) removes the voter from every option;
//   • identity-canonical — LID and PN forms of one person collapse to a single voter, so
//     nobody is double-counted (FR-026). We reuse the same pure `IdentityResolver` logic as
//     the live path: learn every LID↔PN pairing carried on the votes, then re-key voters by
//     the resolver's canonicalId.
//
// This unit is pure and unit-tested in poll-tally.test.ts.
import type { Identity, PollResult, PollVote } from '../types.js';
import { IdentityResolver } from '../identity/identity-resolver.js';

/**
 * Fold per-voter {@link PollVote} deltas into a per-option {@link PollResult}.
 * Stateless: pass the full set of votes observed so far; the result reflects each
 * voter's most recent selection. Options nobody currently selects do not appear.
 */
export function aggregateVotes(votes: PollVote[]): PollResult {
  const pollId = votes[0]?.pollId ?? '';

  // First pass: learn every known LID↔PN pairing so a person seen under one form can be
  // reconciled with the other (mirrors the live IdentityResolver path, FR-026).
  const resolver = new IdentityResolver();
  for (const v of votes) {
    if (v.voter.pn && v.voter.lid) {
      resolver.learnMapping(v.voter.lid, v.voter.pn);
    }
  }

  // Second pass: last-write-per-voter, keyed by a resolver-stable canonicalId.
  const latestByVoter = new Map<string, { voter: Identity; selectedOptions: string[] }>();
  for (const v of votes) {
    const voter = canonicalize(resolver, v.voter);
    latestByVoter.set(voter.canonicalId, { voter, selectedOptions: v.selectedOptions });
  }

  // Invert to per-option voters, preserving first-appearance order of options.
  const order: string[] = [];
  const byOption = new Map<string, Identity[]>();
  for (const { voter, selectedOptions } of latestByVoter.values()) {
    for (const name of selectedOptions) {
      let voters = byOption.get(name);
      if (!voters) {
        voters = [];
        byOption.set(name, voters);
        order.push(name);
      }
      voters.push(voter);
    }
  }

  return {
    pollId,
    options: order.map((name) => {
      const voters = byOption.get(name) ?? [];
      return { name, voters, voteCount: voters.length };
    }),
  };
}

/** Re-resolve an Identity through the resolver so learned LID↔PN pairings merge forms. */
function canonicalize(resolver: IdentityResolver, identity: Identity): Identity {
  const primary = identity.pn ?? identity.lid ?? identity.canonicalId;
  // Supply the counterpart as the alt only when both forms are already on the identity.
  const alt = identity.pn && identity.lid ? identity.lid : undefined;
  return resolver.resolve(primary, alt, identity.displayHint);
}
