/**
 * Phase 12 (Attendance overhaul, Track B) — integration test for
 * object-storage-s3.ts against a real (in-process) S3-compatible server
 * (see test/s3rver-setup.ts). Never skipped — unlike the DB integration
 * tests, this needs no external service or credentials.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestObjectStorage } from "../../../test/s3rver-setup";

describe("object-storage-s3 (integration, against a real S3-compatible server)", () => {
  let stop: () => Promise<void>;
  let storage: typeof import("./object-storage-s3");

  beforeAll(async () => {
    const started = await startTestObjectStorage();
    stop = started.stop;
    // Imported AFTER the env vars are set, so isObjectStorageConfigured()
    // and getClient() both see them — this module reads process.env
    // lazily per-call (readConfig()), not at import time, so import order
    // relative to env-var-setting doesn't actually matter here, but
    // importing fresh per test file keeps this test self-contained.
    storage = await import("./object-storage-s3");
  });

  afterAll(async () => {
    await stop();
  });

  it("isObjectStorageConfigured is true once the env vars are set", () => {
    expect(storage.isObjectStorageConfigured()).toBe(true);
  });

  it("a full upload → head → download → delete round trip works against the real S3 HTTP API", async () => {
    const key = "attendance-photos/test-restaurant/test-user/clock_in/2026-01-01T00-00-00-000Z-abc123.jpg";
    const bytes = Buffer.from("fake jpeg bytes for testing");

    const { url: uploadUrl } = await storage.createAttendancePhotoUploadUrl(key);
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: bytes,
    });
    expect(putRes.ok).toBe(true);

    const head = await storage.headAttendancePhoto(key);
    expect(head.exists).toBe(true);
    expect(head.sizeBytes).toBe(bytes.byteLength);

    const { url: downloadUrl } = await storage.createAttendancePhotoDownloadUrl(key);
    const getRes = await fetch(downloadUrl);
    expect(getRes.ok).toBe(true);
    const downloaded = Buffer.from(await getRes.arrayBuffer());
    expect(downloaded.equals(bytes)).toBe(true);

    await storage.deleteAttendancePhoto(key);
    const headAfterDelete = await storage.headAttendancePhoto(key);
    expect(headAfterDelete.exists).toBe(false);
  });

  it("headAttendancePhoto returns exists:false for a key that was never uploaded — the clock-in/out routes rely on this to reject an unverifiable key", async () => {
    const result = await storage.headAttendancePhoto("attendance-photos/never/uploaded/clock_in/nope.jpg");
    expect(result.exists).toBe(false);
    expect(result.sizeBytes).toBeNull();
  });

  it("deleteAttendancePhoto on an already-missing key does not throw — the retention purge relies on this idempotency", async () => {
    await expect(
      storage.deleteAttendancePhoto("attendance-photos/already/gone/clock_out/nope.jpg"),
    ).resolves.toBeUndefined();
  });
});
