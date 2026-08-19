/**
 * Minimal ambient types for the Web Serial API (navigator.serial) — this
 * is a real, shipping browser API (Chrome/Edge on desktop and Android,
 * behind a user permission prompt) but it is NOT part of TypeScript's
 * bundled lib.dom.d.ts, and this project doesn't pull in a third-party
 * @types package for it. Only the small slice of the spec this codebase
 * actually calls is declared here — see
 * https://wicg.github.io/serial/ for the full spec if more is ever needed.
 */

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: "none" | "even" | "odd";
  bufferSize?: number;
  flowControl?: "none" | "hardware";
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}

interface SerialPortRequestOptions {
  filters?: { usbVendorId?: number; usbProductId?: number }[];
}

interface Serial extends EventTarget {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

interface Navigator {
  readonly serial?: Serial;
}
