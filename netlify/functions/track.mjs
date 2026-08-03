import { getStore } from "@netlify/blobs";

// First-party, anonymous funnel analytics for the marketing site.
// Receives tiny JSON beacons { p, e, s, v } from the landing pages.
//
// ⛔ APPEND-ONLY, ONE BLOB PER EVENT, AND THAT IS THE LOAD-BEARING DECISION.
// Until 2026-08-03 this incremented a per-(page, date) counter object, and its own
// comment admitted the flaw: read-modify-write over a shared key drops writes that
// interleave, so concurrent beacons lose increments. An undercount is the worst
// possible failure for these numbers, because it fails in the direction that says
// "nobody arrived, nobody bought" and no reader can tell that apart from the truth.
// The whole point of this pass is to make the next 100 visitors countable.
//
// So every event is now its own key. Nothing is read before writing, nothing is
// overwritten, and concurrency cannot lose anything. Counting happens at read time
// by listing a prefix, which is slower and correct.
//
// ⭐ This is deliberately the SAME design as frontend/netlify/functions/track-event.ts
// (append-only, one blob per event, no env var, ids generated client-side). Two sinks,
// one design. Do not invent a third.
//
// ⚠ NO ENV VAR, ON PURPOSE. A sink whose behaviour depends on a variable somebody has
// to remember to set is a sink that silently records nothing.
//
// ⚠ HISTORY IS IN A DIFFERENT STORE AND IS NOT MIGRATED. Counts before 2026-08-03 live
// in store "analytics" under keys "<page>/<YYYY-MM-DD>" as counter objects. They stay
// exactly where they are: that history is the 33-views / 8-checkout-mounts denominator
// the whole offer strategy rests on, and rewriting it would destroy the only measured
// traffic record the business owns. Read the old shape with
//   netlify blobs:get analytics ed/2026-07-14
// and the new shape by listing store "page-events" (keys are <date>/<page>/<event>/<uuid>).
//
// ⚠ NO PII. An event name, a page, a coarse source label and a random visitor id. The
// visitor id exists only so a reader can tell a NEW PERSON from the same person
// reloading. It is a random value with no relationship to any identity, it is never
// joined to an email, and it is never accepted from a query string.

const EVENTS = new Set([
  "view", "s25", "s50", "s75", "s90",
  "cta_header", "cta_hero", "cta_mid", "cta_sticky",
  "checkout_view", "checkout_mount",
  // grant-office direct checkout funnel (2026-07-16):
  "calendly_click", "tier_select", "intake_submit", "paid_verified",
  // conversion pass (2026-07-16 second deploy): per-tier splits, money-moment
  // failure visibility, downsell and FAQ path counters, intake-seam telemetry
  "tier_select_half", "tier_select_three_quarters", "tier_select_all",
  "checkout_error", "dfy_disabled_click", "downsell_click", "cta_faq",
  "arrived_with_session", "intake_error",
  // money moment (2026-08-03). `purchase` fires on /check-intake, NOT on /ed:
  // Stripe's embedded checkout redirects the top-level page to the return_url on
  // payment, so /ed is already gone when the money lands. See check-intake.html.
  "purchase",
]);

const PAGE_RE = /^[a-z0-9_-]{1,16}$/;
const SOURCE_RE = /^[a-z0-9_-]{1,24}$/;
const VISITOR_RE = /^[a-z0-9]{1,32}$/;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  // sendBeacon posts text/plain unless the caller wraps the body in a typed Blob,
  // so read as text and parse rather than trusting req.json().
  let body;
  try {
    const raw = await req.text();
    if (!raw || raw.length > 4000) return new Response(null, { status: 400 });
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }

  const page = typeof body.p === "string" && PAGE_RE.test(body.p) ? body.p : null;
  const event = typeof body.e === "string" && EVENTS.has(body.e) ? body.e : null;
  if (!page || !event) {
    return new Response(null, { status: 400 });
  }
  // Source and visitor are optional: pages deployed before this pass send neither,
  // and their events must still count. An unattributed event is worth more than a
  // dropped one.
  const source = typeof body.s === "string" && SOURCE_RE.test(body.s) ? body.s : "";
  const visitor = typeof body.v === "string" && VISITOR_RE.test(body.v) ? body.v : "";

  try {
    const store = getStore("page-events");
    // Server time, not client time: a client clock can be wrong or spoofed, and this
    // is the field every count buckets on.
    const ts = new Date().toISOString();
    // Date prefix first so one day can be listed without scanning everything; page and
    // event next so a single funnel step can be counted directly. The random suffix is
    // what makes this append-only: no two writes can collide, so none can clobber another.
    const key = `${ts.slice(0, 10)}/${page}/${event}/${crypto.randomUUID()}`;
    await store.setJSON(key, { page, event, source, visitor, ts });
  } catch (err) {
    // Analytics must never surface an error to the page; log it server-side so the
    // failure is visible in function logs rather than silent.
    console.error("track: blob write failed:", err && err.message);
  }

  return new Response(null, { status: 204 });
};
