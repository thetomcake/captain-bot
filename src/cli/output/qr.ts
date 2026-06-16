/**
 * QR rendering for the MVP side (FR-007). The Gateway surfaces a raw QR string via `onQR`; the MVP
 * renders it as both a terminal QR (for an attached operator) and a saved PNG (for headless/remote
 * setups), printing the PNG path and best-effort opening it with the platform image viewer.
 *
 * Shared by `connect` (T044) and `daemon` (T045) so both pairing surfaces render identically.
 */
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { logger } from '../../utils/logger.js';

const QR_PNG_PATH = path.join(os.tmpdir(), 'captain-stats-qr.png');

/** Best-effort open of the saved PNG with the platform viewer (`open` on macOS, else `xdg-open`). */
function tryOpen(filePath: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [filePath], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Best-effort only — silently ignore if no graphical opener is available (headless server).
  }
}

/**
 * Render a Gateway QR value to the terminal and a saved PNG (FR-007). Prints the PNG path **and**
 * attempts to open it with `xdg-open`/`open`. Never throws — QR rendering must not abort pairing.
 */
export function renderQr(qr: string): void {
  console.log('\nScan this QR code with WhatsApp (Linked Devices → Link a Device):\n');
  qrcodeTerminal.generate(qr, { small: true });

  void QRCode.toFile(QR_PNG_PATH, qr)
    .then(() => {
      console.log(`\nQR code also saved to: ${QR_PNG_PATH}`);
      tryOpen(QR_PNG_PATH);
    })
    .catch((error: unknown) => {
      logger.warn('Could not save QR PNG (terminal QR still shown)', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
