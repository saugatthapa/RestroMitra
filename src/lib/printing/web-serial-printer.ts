"use client";

/**
 * Browser-side thermal printer connection via the Web Serial API. This is
 * what actually lets a KOT print without the OS print dialog: most
 * inexpensive thermal printers sold for small restaurants connect over USB
 * using a USB-to-serial bridge chip (CH340/CP2102 and similar), which Web
 * Serial can talk to directly from the page — no local helper app needed.
 * The real limitation is browser support: Chrome/Edge on desktop and
 * Android, nothing else (no Firefox, no Safari, no iOS at all — WebKit has
 * not implemented this API). See isWebSerialSupported() below; every call
 * site in this app treats "unsupported" as "fall back to the existing
 * browser print dialog," never as an error, since that's the honest
 * situation on those browsers.
 *
 * Pairing model: navigator.serial.requestPort() can only be called from a
 * direct user gesture (a click) and shows the browser's own device picker
 * — there is no way to skip that dialog, by design (same reasoning as
 * every other powerful-permission API). Once granted, Chrome remembers the
 * permission across page loads, so navigator.serial.getPorts() returns it
 * again without re-prompting. This module additionally remembers the
 * paired device's USB vendor/product id in localStorage purely so it can
 * pick the SAME port back out of getPorts() automatically on the next
 * visit (getPorts() can return multiple previously-granted ports and gives
 * no "this is the one from last time" signal on its own).
 */

const STORAGE_KEY = "dhankipos:thermal-printer";

type StoredPrinter = { usbVendorId?: number; usbProductId?: number; baudRate: number; label: string };

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator && !!navigator.serial;
}

function readStoredPrinter(): StoredPrinter | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredPrinter) : null;
  } catch {
    return null;
  }
}

function writeStoredPrinter(info: StoredPrinter | null) {
  if (typeof window === "undefined") return;
  if (info) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
  else window.localStorage.removeItem(STORAGE_KEY);
}

export function getStoredPrinterLabel(): string | null {
  return readStoredPrinter()?.label ?? null;
}

export function forgetPairedPrinter(): void {
  writeStoredPrinter(null);
}

/**
 * Re-resolves the previously paired port WITHOUT prompting the user —
 * safe to call on every page load. Returns null if nothing's paired yet,
 * or if the paired device isn't among the browser's currently-granted
 * ports (unplugged, permission revoked from chrome://settings, etc.) —
 * either case, callers should fall back to the browser print dialog.
 */
export async function resolvePairedPort(): Promise<SerialPort | null> {
  if (!isWebSerialSupported()) return null;
  const stored = readStoredPrinter();
  if (!stored) return null;

  const ports = await navigator.serial!.getPorts();
  const match = ports.find((p) => {
    const info = p.getInfo();
    return info.usbVendorId === stored.usbVendorId && info.usbProductId === stored.usbProductId;
  });
  return match ?? null;
}

/**
 * The pairing flow — MUST be called from inside a click handler (or other
 * direct user-gesture event), never from a useEffect or a timer, or the
 * browser silently rejects the permission prompt. `label` is a
 * human-readable name for the settings UI ("Kitchen printer") since the
 * USB vendor/product id pair means nothing to a restaurant owner.
 */
export async function pairPrinter(
  label: string,
  baudRate: number = 9600,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isWebSerialSupported()) {
    return { ok: false, error: "This browser doesn't support direct printer connections." };
  }
  try {
    const port = await navigator.serial!.requestPort();
    const info = port.getInfo();
    writeStoredPrinter({
      usbVendorId: info.usbVendorId,
      usbProductId: info.usbProductId,
      baudRate,
      label: label.trim() || "Thermal printer",
    });
    return { ok: true };
  } catch (err) {
    // The user closing the picker without choosing a device throws a
    // DOMException here — that's a normal cancel, not a real error, but
    // there's nothing meaningfully different to tell them either way.
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't connect to a printer.",
    };
  }
}

/**
 * Sends a pre-built ESC/POS byte sequence (see escpos.ts) to the paired
 * printer. Opens the port, writes, and closes it again around every print
 * — a thermal printer only ever gets one job at a time in this app, so
 * there's no benefit to holding the port open between prints, and closing
 * it means a second tab/device trying to print isn't silently blocked by
 * an already-open connection.
 */
export async function printToThermalPrinter(
  bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const stored = readStoredPrinter();
  const port = await resolvePairedPort();
  if (!port || !stored) {
    return { ok: false, error: "No thermal printer is paired on this device." };
  }

  try {
    await port.open({ baudRate: stored.baudRate });
    const writer = port.writable?.getWriter();
    if (!writer) throw new Error("Printer connection has no writable stream.");
    await writer.write(bytes);
    writer.releaseLock();
    await port.close();
    return { ok: true };
  } catch (err) {
    try {
      await port.close();
    } catch {
      // already closed / never fully opened — nothing more to clean up
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't send the ticket to the printer.",
    };
  }
}
