import { z } from "zod";

// Phase 25 — shape of `PushSubscription.toJSON()` from the browser's Push
// API, as POSTed by NotificationPermissionGate after pushManager.subscribe()
// succeeds. `endpoint` is a push-service URL (FCM for Chrome, Mozilla's
// autopush for Firefox, ...) — arbitrary length, so no max beyond a generous
// sanity cap; `keys.p256dh`/`keys.auth` are base64url-encoded and short.
export const savePushSubscriptionSchema = z.object({
  endpoint: z.string().trim().min(1, "Missing endpoint.").max(2000, "Endpoint is too long."),
  keys: z.object({
    p256dh: z.string().trim().min(1, "Missing p256dh key.").max(500, "p256dh key is too long."),
    auth: z.string().trim().min(1, "Missing auth key.").max(500, "auth key is too long."),
  }),
});

export type SavePushSubscriptionInput = z.infer<typeof savePushSubscriptionSchema>;
