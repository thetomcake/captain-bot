// Canonical identity resolution: reconcile a person's PN and LID forms into one
// stable `canonicalId` so they are never double-counted in messages or votes
// (FR-025/FR-026). Built against the verified rc13 jid-utils (research.md §10).
//
// WhatsApp now addresses the same human two ways: a phone-number JID
// (`…@s.whatsapp.net`, "PN") and a hidden-number LID (`…@lid`). v7 carries the
// counterpart of whatever form arrived in a sibling `*Alt` field
// (`participantAlt`/`remoteJidAlt`) — that is how the two forms are correlated.
//
// RECONCILIATION RELIES ON THE COUNTERPART ARRIVING IN A `*Alt` FIELD. When a
// sighting includes the alt, we learn the LID↔PN pairing and key everything by
// the PN form thereafter. When the `*Alt` is ABSENT and the pairing was never
// learned, the same person seen as LID once and PN another time WILL be counted
// as two identities — this is the documented limitation (FR-026). The robust
// fallback is to consult `sock.signalRepository.lidMapping`
// (`getLIDForPN`/`getLIDsForPNs`); that lookup is socket-bound and therefore lives
// in the gateway shell, which can seed this resolver via `learnMapping()`.
// TODO(gateway, T039): seed learnMapping() from sock.signalRepository.lidMapping
// for the authorized group so LID-only votes attribute correctly even when no
// `*Alt` was ever observed. Tracked alongside the LID poll-vote work.
import { jidNormalizedUser, isPnUser, isLidUser } from '@whiskeysockets/baileys';
import type { Identity } from '../types.js';

export class IdentityResolver {
  /** Learned LID → PN pairings (normalized forms), populated from `*Alt` counterparts. */
  private readonly lidToPn = new Map<string, string>();
  /** Learned PN → LID pairings (normalized forms). */
  private readonly pnToLid = new Map<string, string>();

  /**
   * Record a known LID↔PN pairing. Called when a sighting carries its `*Alt`
   * counterpart, or seeded by the gateway from `signalRepository.lidMapping`.
   */
  learnMapping(lid: string, pn: string): void {
    const normLid = jidNormalizedUser(lid);
    const normPn = jidNormalizedUser(pn);
    this.lidToPn.set(normLid, normPn);
    this.pnToLid.set(normPn, normLid);
  }

  /**
   * Resolve a sighting (primary JID + optional `*Alt` counterpart + optional
   * display hint) to a canonical {@link Identity}. Prefers the PN form for
   * `canonicalId`; strips device suffixes; reconciles via learned pairings.
   */
  resolve(primaryJid: string, altJid?: string, displayHint?: string): Identity {
    const primary = jidNormalizedUser(primaryJid);
    const alt = altJid ? jidNormalizedUser(altJid) : undefined;

    let pn: string | undefined;
    let lid: string | undefined;

    // Classify the primary form.
    if (isPnUser(primary)) {
      pn = primary;
    } else if (isLidUser(primary)) {
      lid = primary;
    }

    // Classify the alt form (the counterpart). Only useful if it is the *other*
    // form — a same-form alt (e.g. another PN device) teaches us nothing new.
    if (alt) {
      if (isPnUser(alt)) {
        pn = pn ?? alt;
      } else if (isLidUser(alt)) {
        lid = lid ?? alt;
      }
    }

    // If we now know both forms, learn the pairing for future sightings.
    if (pn && lid) {
      this.learnMapping(lid, pn);
    }

    // Fill any missing form from previously-learned pairings.
    if (lid && !pn) {
      pn = this.lidToPn.get(lid);
    }
    if (pn && !lid) {
      lid = this.pnToLid.get(pn);
    }

    // canonicalId prefers PN; else the normalized primary (LID, or anything else).
    const canonicalId = pn ?? lid ?? primary;

    const identity: Identity = { canonicalId };
    if (pn) identity.pn = pn;
    if (lid) identity.lid = lid;
    if (displayHint) identity.displayHint = displayHint;
    return identity;
  }
}
