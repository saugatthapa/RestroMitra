import "server-only";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Phase 12 (Attendance overhaul, Track B) — object storage for attendance
 * selfies via any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze
 * B2, or a self-hosted MinIO — they all speak the same S3 API, so one
 * client works unchanged across providers; only the env vars below
 * differ per provider). This is deliberately the ONLY place in this
 * codebase that stores an image outside a Postgres text/base64 column —
 * see the Platform Control Center plan's §2 for why that pattern (fine for
 * logos/menu photos) is unacceptable for selfies: privacy-sensitive,
 * needs retention/deletion, needs short-lived signed access, never public.
 *
 * Photos never pass through this server's own request/response cycle: the
 * browser uploads directly to the bucket via a presigned PUT URL, and
 * views a photo via a presigned GET URL minted fresh on demand — this
 * server only ever handles keys and signed URLs, never raw image bytes.
 *
 * Env vars (see .env.example for the full documented block):
 *   OBJECT_STORAGE_ENDPOINT        — e.g. https://<accountid>.r2.cloudflarestorage.com
 *                                     (omit entirely for real AWS S3 — the
 *                                     SDK derives the right endpoint from
 *                                     OBJECT_STORAGE_REGION instead)
 *   OBJECT_STORAGE_REGION          — required (AWS S3: a real region like
 *                                     "ap-south-1"; R2/B2/MinIO: "auto" or
 *                                     any placeholder, they ignore it)
 *   OBJECT_STORAGE_BUCKET          — required
 *   OBJECT_STORAGE_ACCESS_KEY_ID   — required
 *   OBJECT_STORAGE_SECRET_ACCESS_KEY — required
 *   OBJECT_STORAGE_FORCE_PATH_STYLE  — "true" for R2/B2/MinIO (path-style
 *                                     addressing); unset/"false" for AWS S3
 *
 * Every function below is a no-op-safe no-throw check via
 * isObjectStorageConfigured() first — routes call that up front and treat
 * "not configured" as "the selfie feature isn't available on this
 * deployment yet," the same graceful-degradation convention as
 * ask-db.ts's *_API_KEY handling and email.ts's RESEND_API_KEY handling,
 * rather than every route needing its own try/catch around a throwing
 * client constructor.
 */

function readConfig() {
  const region = process.env.OBJECT_STORAGE_REGION;
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!region || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT || undefined,
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
  };
}

export function isObjectStorageConfigured(): boolean {
  return readConfig() !== null;
}

let cachedClient: S3Client | null = null;
let cachedBucket: string | null = null;

/** Throws if not configured — every exported function below checks isObjectStorageConfigured() first, so this should never throw in practice. */
function getClient(): { client: S3Client; bucket: string } {
  const config = readConfig();
  if (!config) {
    throw new Error(
      "Object storage isn't configured (OBJECT_STORAGE_* env vars missing) — callers must check isObjectStorageConfigured() first.",
    );
  }
  // Cached across calls within this process (same convention as db/index.ts's
  // connection reuse) — the SDK client itself is safe to share; only the
  // bucket name (also cached) needs to travel alongside it since callers
  // pass keys, not bucket-qualified paths.
  if (!cachedClient || cachedBucket !== config.bucket) {
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    cachedBucket = config.bucket;
  }
  return { client: cachedClient, bucket: cachedBucket };
}

const UPLOAD_URL_TTL_SECONDS = 5 * 60; // 5 minutes to complete the browser upload
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60; // 5 minutes to view — minted fresh per view, never persisted

/**
 * A presigned PUT URL the browser uploads a selfie to directly. Restricted
 * to image/jpeg (the only format the capture UI ever produces) and a
 * generous-but-bounded size ceiling enforced via Content-Length policy —
 * the SDK's presigned PUT can't cap size on its own, so the caller (the
 * upload-URL route) is documented to also verify the object's actual size
 * after upload via headAttendancePhoto() before trusting it.
 */
export async function createAttendancePhotoUploadUrl(
  key: string,
): Promise<{ url: string; expiresAt: Date }> {
  const { client, bucket } = getClient();
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "image/jpeg" });
  const url = await getSignedUrl(client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
  return { url, expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000) };
}

/** A presigned GET URL for viewing one photo — minted fresh per request, never stored (a stored signed URL would just expire and be useless, or if long-lived, defeat the point of signing at all). */
export async function createAttendancePhotoDownloadUrl(
  key: string,
): Promise<{ url: string; expiresAt: Date }> {
  const { client, bucket } = getClient();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const url = await getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000) };
}

/** Confirms an object actually exists (and returns its size) — the clock-in/out routes call this before trusting a client-supplied key as real evidence a photo was captured, not just a well-formed string. */
export async function headAttendancePhoto(key: string): Promise<{ exists: boolean; sizeBytes: number | null }> {
  const { client, bucket } = getClient();
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, sizeBytes: result.ContentLength ?? null };
  } catch (err) {
    // The SDK throws a NotFound-shaped error for a missing key — treated
    // as "doesn't exist" rather than propagated, since that's exactly the
    // caller's own question. Any OTHER failure (auth, network, bucket
    // misconfigured) also surfaces as exists:false here deliberately: a
    // clock-in/out route with a required-photo restaurant should refuse
    // the transition rather than silently accept an unverifiable key, and
    // "storage is down" and "photo doesn't exist" both warrant the same
    // "we couldn't verify your photo, please retake it" user-facing error.
    void err;
    return { exists: false, sizeBytes: null };
  }
}

/** Permanently deletes a stored photo — used by the retention purge job and (later, Phase 13) a per-record manual delete. Idempotent: deleting an already-gone key is not an error. */
export async function deleteAttendancePhoto(key: string): Promise<void> {
  const { client, bucket } = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
