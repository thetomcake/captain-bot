import { describe, it, expect } from 'vitest';
import { aggregateVotes } from '#src/whatsapp-gateway/polls/poll-tally.js';
import type { PollVote } from '#src/whatsapp-gateway/types.js';

const PN = '12345678901@s.whatsapp.net';
const LID = '98765@lid';
const OTHER_PN = '22222222222@s.whatsapp.net';

function vote(partial: Partial<PollVote> & Pick<PollVote, 'voter' | 'selectedOptions'>): PollVote {
  return {
    pollId: 'POLL1',
    groupId: 'group@g.us',
    timestamp: new Date('2026-06-15T10:00:00Z'),
    ...partial,
  };
}

describe('aggregateVotes (FR-022/FR-023/FR-026)', () => {
  it('returns an empty result for no votes', () => {
    const result = aggregateVotes([]);
    expect(result.options).toEqual([]);
  });

  it('carries the pollId from the votes', () => {
    const result = aggregateVotes([
      vote({ voter: { canonicalId: PN, pn: PN }, selectedOptions: ['Yes'] }),
    ]);
    expect(result.pollId).toBe('POLL1');
  });

  it('tallies each option with its voters and voteCount', () => {
    const result = aggregateVotes([
      vote({ voter: { canonicalId: PN, pn: PN }, selectedOptions: ['Yes'] }),
      vote({ voter: { canonicalId: OTHER_PN, pn: OTHER_PN }, selectedOptions: ['No'] }),
    ]);
    const yes = result.options.find((o) => o.name === 'Yes');
    const no = result.options.find((o) => o.name === 'No');
    expect(yes?.voteCount).toBe(1);
    expect(no?.voteCount).toBe(1);
    expect(yes?.voters.map((v) => v.canonicalId)).toEqual([PN]);
  });

  it('applies last-write-per-voter: a later selection replaces the earlier one', () => {
    const result = aggregateVotes([
      vote({ voter: { canonicalId: PN, pn: PN }, selectedOptions: ['Yes'] }),
      vote({ voter: { canonicalId: PN, pn: PN }, selectedOptions: ['No'] }),
    ]);
    expect(result.options.find((o) => o.name === 'Yes')).toBeUndefined();
    expect(result.options.find((o) => o.name === 'No')?.voteCount).toBe(1);
  });

  it('treats an empty selection as a withdrawal that removes the voter', () => {
    const result = aggregateVotes([
      vote({ voter: { canonicalId: PN, pn: PN }, selectedOptions: ['Yes'] }),
      vote({ voter: { canonicalId: PN, pn: PN }, selectedOptions: [] }),
    ]);
    expect(result.options).toEqual([]);
  });

  it('counts a multi-select snapshot under every selected option', () => {
    const result = aggregateVotes([
      vote({ voter: { canonicalId: PN, pn: PN }, selectedOptions: ['Yes', 'No'] }),
    ]);
    expect(result.options.find((o) => o.name === 'Yes')?.voteCount).toBe(1);
    expect(result.options.find((o) => o.name === 'No')?.voteCount).toBe(1);
  });

  it('does not double-count one person seen as LID then PN (canonical merge, last-write)', () => {
    const result = aggregateVotes([
      // First sighting: LID-only form (canonicalId is the LID).
      vote({ voter: { canonicalId: LID, lid: LID }, selectedOptions: ['Yes'] }),
      // Later sighting: carries both forms, so the LID↔PN pairing is learnable.
      vote({ voter: { canonicalId: PN, pn: PN, lid: LID }, selectedOptions: ['No'] }),
    ]);
    // The two sightings are the same human → one voter, last write ('No') wins.
    const totalVoters = result.options.reduce((n, o) => n + o.voters.length, 0);
    expect(totalVoters).toBe(1);
    expect(result.options.find((o) => o.name === 'Yes')).toBeUndefined();
    const no = result.options.find((o) => o.name === 'No');
    expect(no?.voteCount).toBe(1);
    expect(no?.voters[0]?.canonicalId).toBe(PN);
  });
});
