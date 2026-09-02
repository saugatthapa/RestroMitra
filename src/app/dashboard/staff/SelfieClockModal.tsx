"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";

type Kind = "clock_in" | "clock_out";
// P2 gap-audit fix — "selfie" (the original, staff-identity photo) or
// "workplace" (the new, separate surroundings photo proving they're
// actually AT the restaurant). Deliberately NOT a second, near-duplicate
// modal component: every step here (consent → camera → capture → confirm
// → upload) is identical for both, so this same component is reused,
// parameterized by `purpose`, rather than forking the capture logic.
type Purpose = "selfie" | "workplace";

type ConsentStatus = {
  hasCurrentConsent: boolean;
  noticeVersion: string;
  noticeTitle: string;
  noticeText: string;
};

type UploadUrlResponse = { uploadUrl: string; key: string; contentType: string };

/**
 * Phase 12 (Attendance overhaul, Track B) — the selfie-capture flow shown
 * when a restaurant has turned on selfieClockInRequired. Walks: consent
 * notice (only if not already current) → live camera preview → capture →
 * confirm/retake → direct browser upload to object storage → hands the
 * verified object key back to the caller, which then calls clock-in/out
 * with it (see AttendanceTab in StaffBoard.tsx).
 *
 * P2 gap-audit fix — also reused, unmodified in structure, for the
 * separate workplace/surroundings photo via the `purpose` prop: same
 * consent → camera → capture → confirm → upload steps, just a different
 * object-storage kind, camera facing hint, and copy.
 *
 * The upload step PUTs straight to the presigned URL with the browser's
 * own fetch — NOT through this app's api-client (that's for this app's
 * own JSON API, not a cross-origin bucket PUT). This means the bucket
 * itself needs CORS configured to allow PUT from this app's origin — see
 * .env.example's OBJECT_STORAGE_* block for that operator-side
 * requirement; a CORS failure here surfaces as a generic "couldn't upload"
 * message since the browser doesn't expose more detail for a blocked
 * cross-origin request.
 */
export function SelfieClockModal({
  slug,
  kind,
  purpose = "selfie",
  onDone,
  onClose,
}: {
  slug: string;
  kind: Kind;
  /** P2 gap-audit fix — which of the two distinct photos this capture is for. Defaults to "selfie" so every pre-existing call site keeps behaving exactly as before. */
  purpose?: Purpose;
  onDone: (photoObjectKey: string) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"loading" | "consent" | "camera" | "preview" | "uploading" | "error">(
    "loading",
  );
  const [consent, setConsent] = useState<ConsentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [capturedPreviewUrl, setCapturedPreviewUrl] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const base = `/api/restaurants/${slug}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<ConsentStatus>(`${base}/attendance/photo-consent`);
        if (cancelled) return;
        setConsent(res);
        setStep(res.hasCurrentConsent ? "camera" : "consent");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load the consent notice.");
        setStep("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    if (step !== "camera") return;
    let cancelled = false;
    (async () => {
      try {
        // P2 gap-audit fix — a workplace photo wants the REAR camera (the
        // surroundings, not the staff member's own face); "environment" is
        // only a hint a device may ignore (e.g. most laptops have no rear
        // camera at all), so this degrades gracefully to whatever camera
        // is actually available either way.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: purpose === "workplace" ? "environment" : "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch {
        if (cancelled) return;
        setError(
          "Couldn't access your camera. Please allow camera access and try again, or ask your manager for help.",
        );
        setStep("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // purpose is a prop that doesn't change over the modal's lifetime (the
    // caller mounts a fresh modal per purpose); omitted so a hypothetical
    // parent re-render doesn't tear down and restart an in-progress camera
    // stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Always stop the camera stream when it's no longer needed (leaving
  // "camera" step, or the whole modal unmounting) — a selfie feature that
  // silently leaves the camera light on after the user is done with it is
  // exactly the kind of privacy-eroding bug this feature has to avoid.
  useEffect(() => {
    if (step === "camera") return;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [step]);
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      if (capturedPreviewUrl) URL.revokeObjectURL(capturedPreviewUrl);
    };
  }, [capturedPreviewUrl]);

  async function acceptConsent() {
    setConsentBusy(true);
    setError(null);
    try {
      await apiPost(`${base}/attendance/photo-consent`, { accept: true });
      setStep("camera");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record your consent.");
    } finally {
      setConsentBusy(false);
    }
  }

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("Couldn't capture that photo — please try again.");
          return;
        }
        setCapturedBlob(blob);
        setCapturedPreviewUrl(URL.createObjectURL(blob));
        setStep("preview");
      },
      "image/jpeg",
      0.85,
    );
  }

  function retake() {
    if (capturedPreviewUrl) URL.revokeObjectURL(capturedPreviewUrl);
    setCapturedBlob(null);
    setCapturedPreviewUrl(null);
    setStep("camera");
  }

  async function confirmAndUpload() {
    if (!capturedBlob) return;
    setStep("uploading");
    setError(null);
    try {
      // P2 gap-audit fix — the workplace photo mints its key under a
      // distinct "..._workplace" kind (see attendance-photo-key.ts) so it
      // can never collide with, or be confused for, the selfie key for
      // the same shift event.
      const uploadKind = purpose === "workplace" ? (`${kind}_workplace` as const) : kind;
      const { uploadUrl, key, contentType } = await apiPost<UploadUrlResponse>(
        `${base}/attendance/photo-upload-url`,
        { kind: uploadKind },
      );
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: capturedBlob,
      });
      if (!putRes.ok) {
        throw new Error("Upload failed");
      }
      onDone(key);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't upload your photo. Please check your connection and try again.",
      );
      setStep("preview");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface-2 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">
            {purpose === "workplace"
              ? kind === "clock_in"
                ? "Workplace photo to clock in"
                : "Workplace photo to clock out"
              : kind === "clock_in"
                ? "Selfie to clock in"
                : "Selfie to clock out"}
          </h3>
          <button type="button" onClick={onClose} className="text-sm text-ink-faint hover:text-ink-secondary">
            Cancel
          </button>
        </div>

        {step === "loading" && <p className="text-sm text-ink-muted">Loading…</p>}

        {step === "error" && (
          <div>
            <p className="mb-3 text-sm text-red-400">{error}</p>
            <button type="button" onClick={onClose} className="btn-secondary w-full">
              Close
            </button>
          </div>
        )}

        {step === "consent" && consent && (
          <div>
            <p className="mb-1 text-sm font-medium text-ink">{consent.noticeTitle}</p>
            <div className="mb-4 max-h-64 overflow-y-auto whitespace-pre-line rounded-lg bg-surface-1 p-3 text-xs text-ink-secondary">
              {consent.noticeText}
            </div>
            {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={consentBusy}
                onClick={acceptConsent}
                className="btn-primary flex-1"
              >
                {consentBusy ? "Saving…" : "I agree"}
              </button>
              <button type="button" onClick={onClose} className="btn-secondary flex-1">
                Not now
              </button>
            </div>
          </div>
        )}

        {step === "camera" && (
          <div>
            {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="mb-3 aspect-square w-full rounded-lg bg-surface-0 object-cover"
            />
            <canvas ref={canvasRef} className="hidden" />
            {purpose === "workplace" && (
              <p className="mb-2 text-xs text-ink-muted">
                Point the camera at your surroundings — this photo doesn&apos;t need to show your face.
              </p>
            )}
            <button type="button" onClick={capture} className="btn-primary w-full">
              Take photo
            </button>
          </div>
        )}

        {(step === "preview" || step === "uploading") && capturedPreviewUrl && (
          <div>
            {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
            {/* eslint-disable-next-line @next/next/no-img-element -- a transient in-memory object URL, not a servable asset next/image can optimize */}
            <img
              src={capturedPreviewUrl}
              alt={purpose === "workplace" ? "Captured workplace photo preview" : "Captured selfie preview"}
              className="mb-3 aspect-square w-full rounded-lg object-cover"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={step === "uploading"}
                onClick={confirmAndUpload}
                className="btn-primary flex-1"
              >
                {step === "uploading" ? "Uploading…" : "Use this photo"}
              </button>
              <button
                type="button"
                disabled={step === "uploading"}
                onClick={retake}
                className="btn-secondary flex-1"
              >
                Retake
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
