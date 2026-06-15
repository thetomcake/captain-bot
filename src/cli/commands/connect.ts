/**
 * `connect` command — placeholder pending the Gateway-native rewrite (T044, Phase 8).
 *
 * The previous implementation drove Baileys directly (makeWASocket + the deleted
 * `useDatabaseAuthState`) and is removed by the Phase 2 Gateway cutover (FR-006/SC-011). The
 * reworked command — `gateway.connect()` + `listGroups()`, MVP-rendered terminal QR and saved
 * PNG, and the group table with the `AUTHORIZED_GROUP_ID` hint (FR-007/FR-011) — lands in T044.
 *
 * Kept as a thin stub so the Phase 2 codebase contains no Baileys import outside the Gateway and
 * the SC-011 guard stays green; it must not be wired as functional until T044.
 */

export interface ConnectCommandOptions {
  reset?: boolean;
}

export async function connectCommand(_options: ConnectCommandOptions = {}): Promise<void> {
  console.error(
    'The "connect" command is being reworked onto the WhatsApp Gateway (T044) and is not yet ' +
      'available in this build.'
  );
  process.exit(4);
}
