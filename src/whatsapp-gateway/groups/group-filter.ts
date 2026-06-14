// Authorized-group restriction (FR-017/FR-018, research.md §11).
//
// A chat is authorized only if it is BOTH a group JID (`isJidGroup` guard) AND in
// the configured allow-list. This deliberately rejects DMs, the status broadcast,
// newsletters, and any group the consumer did not authorize — preventing
// cross-chat leakage. Used to gate `messages.upsert` (notify only) and poll votes;
// for votes, correlate on the poll-creation message's group JID, not the vote.
import { isJidGroup } from '@whiskeysockets/baileys';

export class GroupFilter {
  private readonly authorized: ReadonlySet<string>;

  constructor(authorizedGroups: string[]) {
    this.authorized = new Set(authorizedGroups);
  }

  /** True only for a group JID that is in the authorized allow-list. */
  isAuthorized(jid: string | undefined): boolean {
    if (!jid || !isJidGroup(jid)) {
      return false;
    }
    return this.authorized.has(jid);
  }
}
