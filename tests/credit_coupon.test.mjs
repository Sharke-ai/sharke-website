/**
 * D121 credit: prove $79 comes off a first month, and that the credit cannot be forged.
 *
 *   node tests/credit_coupon.test.mjs
 *
 * Two halves, because they fail in different ways and one cannot stand in for the other:
 *
 *   A. THE COUPON MECHANIC. Does GFVA_CREDIT_79 actually take $79 off a first
 *      subscription invoice, on BOTH tiers? Asserted against Stripe's own
 *      total_details.amount_discount, not against our intent.
 *
 *   B. THE GATE. create-checkout-session only applies the credit against a session it
 *      has verified with Stripe as a PAID Assessment. Stripe has no API to force a test
 *      checkout to "paid", so the paid path cannot be exercised here and is NOT claimed
 *      below. What IS proven is that every way of claiming the credit WITHOUT having
 *      paid is refused, which is the half that carries the money risk.
 *
 * Test mode only. Refuses a live key. Moves no money.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
const testKey = (env.match(/^STRIPE_TEST_KEY=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
if (!testKey?.startsWith("sk_test_")) { console.error("FATAL: no sk_test_ key."); process.exit(2); }
process.env.STRIPE_SECRET_KEY = testKey;

const { default: handler } = await import("../netlify/functions/create-checkout-session.mjs");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${ok ? "" : `\n       -> ${detail}`}`);
  if (!ok) failures++;
};

const sform = (p) => new URLSearchParams(p).toString();
async function stripePost(pathname, params) {
  const r = await fetch("https://api.stripe.com/v1/" + pathname, {
    method: "POST",
    headers: { Authorization: "Bearer " + testKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: sform(params),
  });
  return { status: r.status, json: await r.json() };
}
async function stripeGet(pathname) {
  const r = await fetch("https://api.stripe.com/v1/" + pathname, {
    headers: { Authorization: "Bearer " + testKey },
  });
  return { status: r.status, json: await r.json() };
}
async function mint(body) {
  const res = await handler(new Request("https://sharke.ai/x", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}

console.log("=".repeat(72));
console.log("A. THE COUPON TAKES $79 OFF THE FIRST MONTH, ON BOTH TIERS");
console.log("=".repeat(72));
for (const [label, cents] of [["under $1M tier", 9900], ["$1M to $3M tier", 15900]]) {
  const made = await stripePost("checkout/sessions", {
    mode: "subscription",
    ui_mode: "embedded",
    return_url: "https://sharke.ai/x?session_id={CHECKOUT_SESSION_ID}",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][product_data][name]": "Sharke Self-Serve",
    "line_items[0][quantity]": "1",
    "discounts[0][coupon]": "GFVA_CREDIT_79",
  });
  if (made.status >= 400) {
    check(`${label}: session created`, false, JSON.stringify(made.json).slice(0, 240));
    continue;
  }
  const s = (await stripeGet(`checkout/sessions/${made.json.id}`)).json;
  const disc = s.total_details?.amount_discount;
  console.log(`   ${label}: subtotal ${s.amount_subtotal}, discount ${disc}, total ${s.amount_total}`);
  check(`${label}: $79 discounted`, disc === 7900, `discount was ${disc}`);
  check(`${label}: total is subtotal minus the credit`,
    s.amount_total === cents - 7900, `total ${s.amount_total}, expected ${cents - 7900}`);
}

console.log();
console.log("   CONTROL: the same session WITHOUT the coupon must show no discount,");
console.log("   or the discount above proves nothing about the coupon.");
const plain = await stripePost("checkout/sessions", {
  mode: "subscription", ui_mode: "embedded",
  return_url: "https://sharke.ai/x?session_id={CHECKOUT_SESSION_ID}",
  "line_items[0][price_data][currency]": "usd",
  "line_items[0][price_data][unit_amount]": "9900",
  "line_items[0][price_data][recurring][interval]": "month",
  "line_items[0][price_data][product_data][name]": "Sharke Self-Serve",
  "line_items[0][quantity]": "1",
});
const plainS = (await stripeGet(`checkout/sessions/${plain.json.id}`)).json;
check("no coupon means no discount", (plainS.total_details?.amount_discount || 0) === 0,
  `got ${plainS.total_details?.amount_discount}`);
check("and the full $99 is charged", plainS.amount_total === 9900, `got ${plainS.amount_total}`);

console.log();
console.log("=".repeat(72));
console.log("B. THE CREDIT CANNOT BE CLAIMED WITHOUT HAVING PAID");
console.log("=".repeat(72));

const noCredit = await mint({ plan: "self_serve", tier: "under_1m" });
check("a plain subscription reports no credit", noCredit.json.creditApplied === false,
  JSON.stringify(noCredit.json).slice(0, 160));

const forged = await mint({ plan: "self_serve", tier: "under_1m", credit_session: "cs_test_FORGEDNOTREAL123" });
check("a forged session id is refused the credit", forged.json.creditApplied === false,
  "a made-up id was accepted, so the credit can be minted from nothing");
check("  and the sale still goes through at full price", forged.status === 200 && !!forged.json.clientSecret);

const junk = await mint({ plan: "self_serve", tier: "under_1m", credit_session: "not-a-session-id" });
check("a malformed id is refused the credit", junk.json.creditApplied === false);

// A REAL but UNPAID Assessment session: the closest thing to the attack that matters,
// someone opening a $79 checkout, abandoning it, and claiming the credit anyway.
const unpaid = await stripePost("checkout/sessions", {
  mode: "payment", ui_mode: "embedded",
  return_url: "https://sharke.ai/check-intake?session_id={CHECKOUT_SESSION_ID}&plan=gfvc",
  "line_items[0][price_data][currency]": "usd",
  "line_items[0][price_data][unit_amount]": "7900",
  "line_items[0][price_data][product_data][name]": "Grant Funding Viability Assessment",
  "line_items[0][quantity]": "1",
  "metadata[plan]": "gfvc",
});
const unpaidId = unpaid.json.id;
const unpaidRead = (await stripeGet(`checkout/sessions/${unpaidId}`)).json;
console.log(`   built a REAL unpaid Assessment session: ${unpaidId.slice(0, 24)}... payment_status=${unpaidRead.payment_status}`);
check("  the fixture is genuinely unpaid, so this control is real",
  unpaidRead.payment_status === "unpaid");
const abandoned = await mint({ plan: "self_serve", tier: "under_1m", credit_session: unpaidId });
check("an unpaid Assessment cannot claim the credit", abandoned.json.creditApplied === false,
  "an abandoned $79 checkout bought a $79 discount");

console.log();
console.log("   NOT PROVEN HERE, and saying so rather than implying otherwise: Stripe has");
console.log("   no API to mark a test checkout paid, so the PAID path was not exercised.");
console.log("   What is proven is that no unpaid route grants the credit.");

console.log();
console.log("=".repeat(72));
if (failures) { console.log(`${failures} CHECK(S) FAILED.`); process.exit(1); }
console.log("ALL CHECKS PASSED. Test mode only; nothing published, no money moved.");
process.exit(0);
