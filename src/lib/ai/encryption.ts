import "server-only";
import crypto from "node:crypto";
import { HttpError } from "@/lib/http-error";

/**
 * Platform Control Center (Phase 7) — AES-256-GCM encryption for AI
 * provider API keys stored in the `ai_provider_configs` table. Deliberately
 * a tiny, dependency-free module (Node's built-in `crypto`, nothing else)
 * so the one thing it does — never let a plaintext key touch disk — is
 * easy to audit in full.
 *
 * AI_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key (openssl
 * rand -base64 32 generates one). Losing this key makes every stored
 * provider key permanently undecryptable — there is no recovery path
 * short of re-entering each provider's key from scratch via /admin/ai-
 * providers, which is why it belongs in the same secret-management tier as
 * the database credentials themselves, not committed anywhere.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;

function getKey(): Buffer {
  const raw = process.env.AI_CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    // A plain Error here used to collapse into api-route-helpers.ts's
    // generic "Something went wrong" 500 — toErrorResponse only special-
    // cases HttpError. The underlying message was still reaching the
    // platform health dashboard's "System errors" alert (recordSystemError
    // logs err.message regardless of type), just not the admin who was
    // actually staring at the failed /admin/ai-providers form. HttpError
    // makes toErrorResponse return THIS message to the caller directly, so
    // a misconfigured deployment says so on the screen where it matters.
    throw new HttpError(
      "AI_CONFIG_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` " +
        "and set it before storing or reading any AI provider config.",
      500,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new HttpError(
      `AI_CONFIG_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes (base64-encoded). ` +
        "Generate one with `openssl rand -base64 32`.",
      500,
    );
  }
  return key;
}

/** Encrypts `plaintext` (an API key) into a single base64 blob: iv || authTag || ciphertext. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Reverses encryptSecret(). Throws (via Node's GCM auth-tag check) if `encoded` was tampered with or encrypted under a different key. */
export function decryptSecret(encoded: string): string {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const ciphertext = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
