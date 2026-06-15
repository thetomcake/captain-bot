// Poll-vote decryption (research.md §7) — the most fragile capability, so its only
// deterministic, testable part (option-hash → name mapping) is a PURE helper that IS
// unit-tested; the `decryptPollVote` crypto boundary itself is exercised via the manual
// entry points (bin/watch-votes.ts) + quickstart Scenario E.
//
// rc13 disables in-core poll-vote auto-decryption (research.md §1/§7), so doing it
// ourselves is the *intended* v7 pattern. We call Baileys' still-exported `decryptPollVote`.
//
// VERIFIED against installed 7.0.0-rc13 (FR-031):
//   • lib/Utils/process-message.js `decryptPollVote({ encPayload, encIv },
//     { pollCreatorJid, pollMsgId, pollEncKey, voterJid })` — the sign material that drives
//     the HMAC/GCM key is `pollMsgId ‖ pollCreatorJid ‖ voterJid ‖ 'Poll Vote' ‖ 0x01`, so a
//     DIFFERENT creator form ⇒ a genuinely different decryption attempt (this is what makes
//     the #2342 try-both real — see C-3).
//   • lib/Utils/messages.js `getAggregateVotesInPollMessage` hashes each option name with
//     `sha256(Buffer.from(optionName))` and matches a vote's `selectedOptions` (SHA256
//     digests) against those. We replicate that hashing here, comparing on hex (robust)
//     rather than the source's `.toString()` (which is Buffer-vs-Uint8Array fragile).
import { createHash } from 'node:crypto';
import { decryptPollVote } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';

/** SHA256 of an option name, as the lowercase-hex digest used for matching. */
function optionNameHashHex(optionName: string): string {
  return createHash('sha256').update(Buffer.from(optionName, 'utf8')).digest('hex');
}

/** Hex-encode a decrypted selected-option digest for comparison. */
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * PURE: map a vote's decrypted selected-option SHA256 digests back to the option
 * NAMES, using the poll's option list. Unknown hashes (no matching option) are
 * ignored. Selection order is preserved. An empty input ⇒ `[]` (a withdrawal).
 *
 * Replicates Baileys' own option-hash matching (verified above, FR-031).
 */
export function mapOptionHashesToNames(
  selectedHashes: ReadonlyArray<Uint8Array | null | undefined>,
  options: string[]
): string[] {
  const nameByHash = new Map<string, string>();
  for (const name of options) {
    nameByHash.set(optionNameHashHex(name), name);
  }
  const names: string[] = [];
  for (const hash of selectedHashes) {
    if (!hash) {
      continue;
    }
    const name = nameByHash.get(toHex(hash));
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/** Context passed to the underlying `decryptPollVote` for one attempt. */
export interface DecryptVoteContext {
  pollCreatorJid: string;
  pollMsgId: string;
  pollEncKey: Uint8Array;
  voterJid: string;
}

/**
 * Injectable seam over Baileys' `decryptPollVote` so the try-both control flow is
 * unit-testable without real crypto. Defaults to the real function.
 */
export interface DecryptVoteDeps {
  decrypt: (
    vote: proto.Message.IPollEncValue,
    ctx: DecryptVoteContext
  ) => Pick<proto.Message.IPollVoteMessage, 'selectedOptions'>;
}

const DEFAULT_DEPS: DecryptVoteDeps = { decrypt: decryptPollVote };

export interface DecryptVoteParams {
  /** The encrypted vote payload from `pollUpdateMessage.vote`. */
  vote: proto.Message.IPollEncValue;
  /** The poll-creation message id (from `pollCreationMessageKey.id`). */
  pollMsgId: string;
  /**
   * Ordered voter-JID candidates to try. A LID-addressed group encrypts the vote under the
   * voter's LID form, a PN group under PN (observed, #1678/#2342), so pass BOTH forms — LID-first
   * in a LID group. The voter JID is part of the decryption sign + GCM AAD, so a wrong form fails
   * the auth tag (the bug this fixes: the voter JID used to be a single PN-preferred value).
   */
  voterCandidates: string[];
  /**
   * Ordered creator-JID candidates to try (#2342). For a LID-addressed group pass
   * `[normalizedLid, pn]`; for a PN group `[pn, lid]`. Each is a genuinely distinct
   * attempt because the creator JID is part of the decryption sign material (C-3).
   */
  creatorCandidates: string[];
  /** The resolved poll secret as raw bytes. */
  pollEncKey: Uint8Array;
  /** The poll's option names, to label the decrypted selection. */
  options: string[];
}

/**
 * Decrypt one poll vote by trying the full **(creator × voter) JID matrix**, returning the
 * voter's selected option NAMES (`[]` = withdrawal), or `null` if every pair fails to decrypt
 * (FR-022/FR-024). Both the creator and voter JID are mixed into the decryption sign + GCM AAD,
 * and a LID group may address either party as LID or PN (#1678/#2342), so we iterate every
 * combination and let GCM's auth tag reject the wrong ones — the correct pair wins, with no risk
 * of a false positive. Never throws on a decryption failure — the caller skips the vote without
 * erroring (FR-021).
 */
export function decryptVote(
  params: DecryptVoteParams,
  deps: DecryptVoteDeps = DEFAULT_DEPS
): string[] | null {
  for (const pollCreatorJid of params.creatorCandidates) {
    for (const voterJid of params.voterCandidates) {
      try {
        const decoded = deps.decrypt(params.vote, {
          pollCreatorJid,
          pollMsgId: params.pollMsgId,
          pollEncKey: params.pollEncKey,
          voterJid,
        });
        return mapOptionHashesToNames(decoded.selectedOptions ?? [], params.options);
      } catch {
        // Wrong (creator, voter) pair ⇒ AES-GCM auth-tag mismatch; try the next combination.
      }
    }
  }
  return null;
}
