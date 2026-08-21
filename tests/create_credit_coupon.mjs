/**
 * Create the D121 credit coupon: $79 off the first subscription invoice.
 *
 *   node tests/create_credit_coupon.mjs test    (sandbox, safe, run this first)
 *   node tests/create_credit_coupon.mjs live    (real Stripe config, founder call)
 *
 * D121 (founder 2026-08-20): "We will let the customer apply the $79 spent to their
 * first month should they choose to subscribe." D123 keeps that mechanic across both
 * self-serve tiers.
 *
 * The coupon is a FIXED $79 off, once. Not a percentage: the credit is a specific
 * amount the buyer already paid, and a percentage would refund the wrong number on
 * the $99 tier ($79 off $99 leaves $20; 79% off leaves $20.79, which is not what was
 * spent). duration=once so it touches the first invoice only and never recurs.
 *
 * It is idempotent by coupon id, so re-running it does not create a second coupon.
 *
 * Creating a coupon moves no money. Nothing can redeem it until a checkout applies it,
 * and create-checkout-session only applies it against a Stripe session it has verified
 * as a PAID $79 Assessment.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MODE = (process.argv[2] || "").toLowerCase();

if (!["test", "live"].includes(MODE)) {
  console.error("usage: node tests/create_credit_coupon.mjs <test|live>");
  process.exit(2);
}

const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
const pick = (name) => (env.match(new RegExp("^" + name + "=(.*)$", "m")) || [])[1]
  ?.trim().replace(/^["']|["']$/g, "");

let key;
if (MODE === "test") {
  key = pick("STRIPE_TEST_KEY");
  if (!key?.startsWith("sk_test_")) { console.error("FATAL: no sk_test_ key."); process.exit(2); }
} else {
  key = pick("STRIPE_SECRET_KEY") || pick("STRIPE_LIVE_KEY");
  if (!key?.startsWith("sk_live_")) {
    console.error("FATAL: no sk_live_ key on this box. The live coupon has to be created");
    console.error("from the Stripe dashboard, or by whoever holds the live key:");
    console.error("  Product catalog > Coupons > New");
    console.error("  id GFVA_CREDIT_79, amount off $79.00 USD, duration Once");
    process.exit(2);
  }
}

const COUPON_ID = "GFVA_CREDIT_79";

async function stripe(pathname, params, method = "GET") {
  const url = "https://api.stripe.com/v1/" + pathname;
  const opts = { method, headers: { Authorization: "Bearer " + key } };
  if (params) {
    opts.body = new URLSearchParams(params).toString();
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const r = await fetch(url, opts);
  return { status: r.status, json: await r.json() };
}

console.log(`mode: ${MODE}`);
const existing = await stripe(`coupons/${COUPON_ID}`);
if (existing.status === 200) {
  const c = existing.json;
  console.log(`coupon ${COUPON_ID} ALREADY EXISTS, not recreating.`);
  console.log(`  amount_off=${c.amount_off} ${c.currency}  duration=${c.duration}  valid=${c.valid}`);
  const ok = c.amount_off === 7900 && c.currency === "usd" && c.duration === "once" && c.valid;
  console.log(ok ? "PASS | it matches D121" : "FAIL | it does NOT match D121, fix it in Stripe");
  process.exit(ok ? 0 : 1);
}

const created = await stripe("coupons", {
  id: COUPON_ID,
  amount_off: "7900",
  currency: "usd",
  duration: "once",
  name: "Assessment credit",
}, "POST");

console.log(`POST /coupons -> HTTP ${created.status}`);
if (created.status >= 400) {
  console.log(JSON.stringify(created.json).slice(0, 400));
  process.exit(1);
}
const c = created.json;
console.log(`  id=${c.id} amount_off=${c.amount_off} ${c.currency} duration=${c.duration} valid=${c.valid}`);
console.log("PASS | coupon created");
process.exit(0);
