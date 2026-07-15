import { getStore } from "@netlify/blobs";

// First-party page-analytics counter (conversion pass 2026-07-14).
// Accepts tiny JSON beacons { p: page, e: event } from the landing pages and
// increments a per-day counter object in Netlify Blobs (store "analytics",
// key "<page>/<YYYY-MM-DD>"). Anonymous by design: no IP, UA, cookie, or
// identifier is read or stored; events not on the allowlist are dropped.
// Read counts back with: netlify blobs:get analytics ed/2026-07-14
// Known tradeoff: read-modify-write means concurrent beacons can lose an
// increment. Fine for trend data; do not treat counts as exact.
const EVENTS = new Set([
  "view", "s25", "s50", "s75", "s90",
  "cta_header", "cta_hero", "cta_mid", "cta_sticky",
  "checkout_view", "checkout_mount",
]);

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  const page = typeof body.p === "string" && /^[a-z0-9_-]{1,16}$/.test(body.p) ? body.p : null;
  const event = typeof body.e === "string" && EVENTS.has(body.e) ? body.e : null;
  if (!page || !event) {
    return new Response(null, { status: 400 });
  }

  try {
    const store = getStore("analytics");
    const key = `${page}/${new Date().toISOString().slice(0, 10)}`;
    const counts = (await store.get(key, { type: "json" })) || {};
    counts[event] = (counts[event] || 0) + 1;
    await store.setJSON(key, counts);
  } catch (err) {
    // Analytics must never surface an error to the page; log it server-side.
    console.error("track: blob write failed:", err && err.message);
  }

  return new Response(null, { status: 204 });
};
