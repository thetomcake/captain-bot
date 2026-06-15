import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mapOptionHashesToNames,
  decryptVote,
  type DecryptVoteDeps,
} from '#src/whatsapp-gateway/polls/poll-vote-decryptor.js';

/**
 * Replicates Baileys' option hashing (verified against the installed 7.0.0-rc13
 * `getAggregateVotesInPollMessage`: `sha256(Buffer.from(optionName))`). A decrypted
 * vote's `selectedOptions` are exactly these SHA256 digests.
 */
function hashOf(name: string): Uint8Array {
  return createHash('sha256').update(Buffer.from(name, 'utf8')).digest();
}

describe('mapOptionHashesToNames (FR-022, pure hash → name)', () => {
  const options = ['Pizza', 'Sushi', 'Tacos'];

  it('maps a single selected hash back to its option name', () => {
    expect(mapOptionHashesToNames([hashOf('Sushi')], options)).toEqual(['Sushi']);
  });

  it('maps multiple selected hashes back to names, preserving selection order', () => {
    expect(mapOptionHashesToNames([hashOf('Tacos'), hashOf('Pizza')], options)).toEqual([
      'Tacos',
      'Pizza',
    ]);
  });

  it('returns an empty array for an empty selection (a withdrawal)', () => {
    expect(mapOptionHashesToNames([], options)).toEqual([]);
  });

  it('ignores an unknown hash that matches no option', () => {
    const unknown = hashOf('Not an option');
    expect(mapOptionHashesToNames([unknown, hashOf('Pizza')], options)).toEqual(['Pizza']);
  });
});

describe('decryptVote — #2342 try-both creator/voter fallback (C-3, FR-024)', () => {
  const PN_VOTER = '12345678901@s.whatsapp.net';
  const CREATOR_LID = '55555@lid';
  const CREATOR_PN = '99999999999@s.whatsapp.net';
  const options = ['Yes', 'No'];

  const LID_VOTER = '198547798528255@lid';

  const baseParams = {
    vote: { encPayload: new Uint8Array([1, 2, 3]), encIv: new Uint8Array([4, 5, 6]) },
    pollMsgId: 'POLLMSG1',
    voterCandidates: [PN_VOTER],
    creatorCandidates: [CREATOR_LID, CREATOR_PN],
    pollEncKey: new Uint8Array(32).fill(7),
    options,
  };

  it('makes GENUINELY DISTINCT creator attempts with different sign-material when the first fails', () => {
    const ctxSeen: Array<{ pollCreatorJid: string; voterJid: string; pollMsgId: string }> = [];
    let call = 0;
    const deps: DecryptVoteDeps = {
      decrypt: (_vote, ctx) => {
        ctxSeen.push({
          pollCreatorJid: ctx.pollCreatorJid,
          voterJid: ctx.voterJid,
          pollMsgId: ctx.pollMsgId,
        });
        call += 1;
        if (call === 1) {
          throw new Error('auth tag mismatch (wrong creator form)');
        }
        return { selectedOptions: [hashOf('Yes')] };
      },
    };

    const result = decryptVote(baseParams, deps);

    expect(result).toEqual(['Yes']);
    expect(ctxSeen).toHaveLength(2);
    // The fallback is a REAL second try: the creator sign-material differs (LID → PN),
    // while voter + pollMsgId are held constant. (The first attempt's bug was that both
    // creator forms were pre-normalized to one string, making the "fallback" byte-identical.)
    expect(ctxSeen[0]?.pollCreatorJid).toBe(CREATOR_LID);
    expect(ctxSeen[1]?.pollCreatorJid).toBe(CREATOR_PN);
    expect(ctxSeen[0]?.pollCreatorJid).not.toBe(ctxSeen[1]?.pollCreatorJid);
    expect(ctxSeen[0]?.voterJid).toBe(ctxSeen[1]?.voterJid);
    expect(ctxSeen[0]?.pollMsgId).toBe(ctxSeen[1]?.pollMsgId);
  });

  it('also varies the VOTER form (real LID-group bug): tries the voter LID when the PN form fails', () => {
    // Reproduces the observed failure: a LID-addressed group encrypts the vote under the voter's
    // LID form, but the PN-preferred form was tried first. The decryptor must fall through to the
    // LID voter form rather than holding the voter JID constant.
    const ctxSeen: Array<{ pollCreatorJid: string; voterJid: string }> = [];
    const deps: DecryptVoteDeps = {
      decrypt: (_vote, ctx) => {
        ctxSeen.push({ pollCreatorJid: ctx.pollCreatorJid, voterJid: ctx.voterJid });
        // Only the (creator LID, voter LID) pair is valid — the proven LID-group pattern.
        if (ctx.pollCreatorJid === CREATOR_LID && ctx.voterJid === LID_VOTER) {
          return { selectedOptions: [hashOf('No')] };
        }
        throw new Error('auth tag mismatch');
      },
    };

    const result = decryptVote(
      { ...baseParams, creatorCandidates: [CREATOR_LID], voterCandidates: [PN_VOTER, LID_VOTER] },
      deps
    );

    expect(result).toEqual(['No']);
    // The voter axis was genuinely varied (PN tried, then LID).
    const votersTried = ctxSeen.map((c) => c.voterJid);
    expect(votersTried).toContain(PN_VOTER);
    expect(votersTried).toContain(LID_VOTER);
  });

  it('tries the full (creator × voter) matrix and stops at the first success', () => {
    const pairs: Array<string> = [];
    const deps: DecryptVoteDeps = {
      decrypt: (_vote, ctx) => {
        pairs.push(`${ctx.pollCreatorJid}|${ctx.voterJid}`);
        if (ctx.pollCreatorJid === CREATOR_PN && ctx.voterJid === LID_VOTER) {
          return { selectedOptions: [hashOf('Yes')] };
        }
        throw new Error('nope');
      },
    };
    const result = decryptVote(
      {
        ...baseParams,
        creatorCandidates: [CREATOR_LID, CREATOR_PN],
        voterCandidates: [PN_VOTER, LID_VOTER],
      },
      deps
    );
    expect(result).toEqual(['Yes']);
    // Reached the (PN creator, LID voter) cell, so at least three pairs were attempted before it.
    expect(pairs).toContain(`${CREATOR_PN}|${LID_VOTER}`);
  });

  it('stops at the first successful attempt without trying further pairs', () => {
    let calls = 0;
    const deps: DecryptVoteDeps = {
      decrypt: (_vote, ctx) => {
        calls += 1;
        expect(ctx.pollCreatorJid).toBe(CREATOR_LID);
        expect(ctx.voterJid).toBe(PN_VOTER);
        return { selectedOptions: [hashOf('No')] };
      },
    };
    expect(decryptVote(baseParams, deps)).toEqual(['No']);
    expect(calls).toBe(1);
  });

  it('returns null when every (creator, voter) pair fails to decrypt', () => {
    const deps: DecryptVoteDeps = {
      decrypt: () => {
        throw new Error('decryption failed');
      },
    };
    expect(decryptVote({ ...baseParams, voterCandidates: [PN_VOTER, LID_VOTER] }, deps)).toBeNull();
  });

  it('maps the decrypted hashes through to option names', () => {
    const deps: DecryptVoteDeps = {
      decrypt: () => ({ selectedOptions: [hashOf('Yes'), hashOf('No')] }),
    };
    expect(decryptVote(baseParams, deps)).toEqual(['Yes', 'No']);
  });
});
