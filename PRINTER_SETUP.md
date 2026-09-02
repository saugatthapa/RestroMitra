# Thermal printer setup

RestroMitra can print Kitchen Order Tickets (KOTs) two ways:

1. **Browser print dialog** (default, works everywhere) — the KOT page opens
   in a small popup and calls the browser's normal print dialog, the same as
   printing any web page. Works on any browser/OS; you pick your printer
   (thermal or regular) from the OS print dialog each time, same as printing
   anything else from a browser.
2. **Direct thermal printing** (optional, faster) — RestroMitra talks
   straight to a USB thermal printer from the page, skipping the print
   dialog entirely. This is what this document covers.

Direct printing currently applies to **Kitchen Order Tickets only**. The
bill/receipt view always uses the browser print dialog.

## Is my printer supported?

Direct printing works with **generic "ESC/POS compatible" thermal
printers** — the inexpensive receipt/kitchen printers commonly sold for
small restaurants (the ones that print on a roll of thermal paper and cut
it automatically). ESC/POS is a command language, not a brand; if your
printer's manual or listing mentions "ESC/POS", "ESC-POS", or "compatible
with EPSON TM series", it will work.

It needs to connect over **USB**. Most of these printers use a USB-to-serial
bridge chip internally (commonly CH340 or CP2102) and present themselves to
the computer as a serial port — that's what makes direct printing possible.
Network/Wi-Fi-only and Bluetooth-only printers are not supported by direct
printing (use the browser print dialog with those instead, via your OS's
own printer driver).

## Browser requirements

Direct printing uses the **Web Serial API**, which only exists in
Chromium-based browsers:

- **Supported**: Google Chrome or Microsoft Edge, on desktop (Windows,
  macOS, Linux/ChromeOS) or Android.
- **Not supported**: Firefox, Safari, or any browser on iOS/iPadOS (Apple's
  WebKit has not implemented this API — this applies to every browser on
  iOS, since they're all WebKit under the hood). On an unsupported browser,
  RestroMitra doesn't show the pairing option at all and every KOT simply
  uses the ordinary browser print dialog — there's nothing to configure.

If you're not sure, open the KOT ticket page — if a small "No thermal
printer connected" box with a **Pair printer** button appears near the top,
your browser supports direct printing. If it doesn't appear, use the print
dialog instead (still works, just requires clicking through the dialog each
time).

## One-time setup, per device

Pairing is remembered **per physical device/browser**, not per restaurant
account — if the kitchen has one computer/tablet next to the printer, pair
it once there. A different device (a manager's laptop, a second tablet)
needs its own pairing if you also want direct printing from it.

1. **Plug the printer in** over USB and turn it on. On Windows, if this is
   the printer's first time being plugged into this computer, Windows may
   need to install a driver for the USB-to-serial chip (CH340/CP2102) —
   this normally happens automatically; if it doesn't, search for
   "CH340 driver" or "CP2102 driver" for your Windows version and install it
   from the chip vendor. macOS and ChromeOS generally need no separate
   driver.
2. In RestroMitra, open any order and let a KOT ticket print (or open one
   manually) — the ticket opens in its own small window.
3. In the box near the top of that ticket, click **Pair printer**.
4. Chrome/Edge shows its own device picker listing available serial
   ports — select the printer from the list and confirm. (If nothing shows
   up, the printer isn't presenting as a serial port to the OS yet — check
   the cable, the driver installation from step 1, and that the printer is
   powered on.)
5. Once paired, check **"Print directly (skip dialog)"**. From then on,
   KOTs on this device print straight to the printer with no dialog.

To stop using direct printing or connect a different printer, click
**Forget** in that same box and pair again.

## Paper width

RestroMitra formats KOT text assuming **58mm paper** (32 characters per
line) by default, the most common width for compact kitchen printers. If
your printer uses 80mm paper (48 characters per line), tickets will still
print correctly but with extra blank space on the right rather than using
the full width — this is a cosmetic difference only, nothing is cut off.

## Troubleshooting

- **"No thermal printer connected on this device"** even after pairing —
  the printer isn't among the browser's currently-granted ports (unplugged,
  powered off, or permission was revoked from the browser's own site
  settings). Reconnect the printer and reload the page; if it still doesn't
  resolve, click Pair printer again.
- **"Paired printer not found — check it's plugged in and turned on"** — the
  device was paired before but isn't showing up right now. Check the USB
  cable and power, then reload the page.
- **A print attempt fails partway** — RestroMitra falls back to the browser
  print dialog automatically if a direct print fails (printer turned off
  mid-print, cable pulled, etc.), so the ticket still reaches you one way or
  another; you don't need to manually retry the direct path.
- **Nepali/Devanagari text on the ticket prints as garbled characters or
  boxes** — this is a hardware limitation, not a RestroMitra bug: most
  inexpensive ESC/POS thermal printers only have built-in fonts for
  Latin/ASCII text and can't render Devanagari script directly. Item names
  print exactly as typed (in whatever script), so this only shows up if
  menu items are named in Devanagari.
- **The pairing button never appears at all** — you're on a browser that
  doesn't support Web Serial (see Browser requirements above). Use the
  browser print dialog on that device instead.
