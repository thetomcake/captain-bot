// PURE: map a requested "seconds until event" window to the nearest WhatsApp-supported pin
// duration bucket (007-auto-pin-poll, FR-004/FR-007).
//
// WhatsApp pin durations are DISCRETE — the only values Baileys' `sendMessage` pin option accepts
// are 24h (86400s), 7d (604800s), or 30d (2592000s) (verified vs @whiskeysockets/baileys@7.0.0-rc13
// — `lib/Types/Message.d.ts` `time?: 86400 | 604800 | 2592000`). "Pin until game time" is therefore
// the smallest bucket that still COVERS the requested window, capped at 30 days.
//
// This bucketing is a Baileys/platform detail, so it lives BELOW the Gateway seam: the MVP passes a
// plain seconds-until-kick-off and never sees the discrete set (FR-007). No Baileys import — pure
// arithmetic over the discrete set.

/** The discrete pin durations WhatsApp accepts: 24h | 7d | 30d. */
export type PinDurationSeconds = 86400 | 604800 | 2592000;

/**
 * Select the smallest WhatsApp pin bucket `>= requestedSeconds`, capped at 30 days. A non-positive
 * request (defensive only — unreachable in the MVP, where game time is always in the future) maps to
 * the 24h floor. See contracts/gateway-pin.md helper table.
 */
export function selectPinDuration(requestedSeconds: number): PinDurationSeconds {
  if (requestedSeconds <= 86400) {
    return 86400;
  }
  if (requestedSeconds <= 604800) {
    return 604800;
  }
  return 2592000;
}
