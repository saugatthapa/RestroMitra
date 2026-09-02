import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { AccountSettingsBoard } from "./AccountSettingsBoard";

// RC audit P1 fix — self-service change-password and "log out other
// sessions" previously didn't exist anywhere in the app (see
// src/app/api/auth/change-password/route.ts's own doc comment). No
// restaurant/permission scoping here — this is account-level, not
// restaurant-level, so any logged-in user reaches it regardless of role.
export default async function AccountSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/dashboard/account");

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">My Account</h1>
        <p className="text-sm text-ink-muted">{session.user.fullName}</p>
      </div>
      <AccountSettingsBoard />
    </div>
  );
}
