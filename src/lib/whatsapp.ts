/**
 * Turns a WhatsApp contact number, stored however an admin typed it (e.g.
 * "9815300234" — a bare 10-digit Nepal mobile number, no country code) into
 * a https://wa.me/ link that opens a chat directly. No "server-only" guard
 * — this is pure string manipulation reused by both the server-rendered
 * /verify-account block screen and the admin settings panel's client-side
 * preview, so it has to run in either environment.
 */
export function whatsappLink(rawNumber: string): string | null {
  const digits = rawNumber.replace(/[^\d]/g, "");
  if (!digits) return null;
  // A bare 10-digit Nepal mobile number (98xxxxxxxx/97xxxxxxxx) has no
  // country code yet — wa.me requires the full international number, so
  // prefix Nepal's 977. A number that's already longer (e.g. typed with
  // the country code included) is left as-is rather than guessing.
  const withCountryCode = /^9[678]\d{8}$/.test(digits) ? `977${digits}` : digits;
  return `https://wa.me/${withCountryCode}`;
}
