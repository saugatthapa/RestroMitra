/**
 * Platform Control Center (Phase 9) — the fixed catalog of support-status
 * tags a support agent can attach to a tenant. A closed set (not free
 * text) so the /admin restaurant list can filter/sort by tag meaningfully
 * and the UI can offer a picker rather than an unbounded text field — the
 * same "small closed set" reasoning behind every pgEnum in this schema,
 * just enforced at the validation layer instead (see
 * restaurant_support_tags's own schema.ts comment for why this is a
 * relational table rather than a Postgres enum column).
 */
export const SUPPORT_TAGS = [
  "vip",
  "at_risk",
  "churn_risk",
  "escalated",
  "needs_follow_up",
  "new",
] as const;

export type SupportTag = (typeof SUPPORT_TAGS)[number];

export function isSupportTag(value: string): value is SupportTag {
  return (SUPPORT_TAGS as readonly string[]).includes(value);
}

export const SUPPORT_TAG_LABELS: Record<SupportTag, string> = {
  vip: "VIP",
  at_risk: "At risk",
  churn_risk: "Churn risk",
  escalated: "Escalated",
  needs_follow_up: "Needs follow-up",
  new: "New",
};
