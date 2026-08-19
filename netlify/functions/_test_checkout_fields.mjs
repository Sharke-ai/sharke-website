/**
 * Prove the checkout now collects a billing address, a PO number and an invoice.
 *
 *   node netlify/functions/_test_checkout_fields.mjs
 *
 * Runs the REAL handler from create-checkout-session.mjs, not a copy of its logic,
 * with STRIPE_SECRET_KEY set to the sk_test_ key. Test mode only: it refuses to run
 * against a live key, so it cannot mint a real session or move money.
 *
 * Each assertion has a control, because a test that cannot fail proves nothing:
 *   - the gfvc arm must gain invoice_creation
 *   - the self_serve arm must NOT, since Stripe rejects invoice_creation on
 *     subscriptions, and a green gfvc result would hide that we broke the $159.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
const testKey = (env.match(/^STRIPE_TEST_KEY=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
if (!testKey || !testKey.startsWith("sk_test_")) {
  console.error("FATAL: no sk_test_ key found. Refusing to run.");
  process.exit(2);
}
process.env.STRIPE_SECRET_KEY = testKey;

const { default: handler } = await import("./create-checkout-session.mjs");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${ok ? "" : `\n       -> ${detail}`}`);
  if (!ok) failures++;
};

async function mint(body) {
  const res = await handler(new Request("https://sharke.ai/.netlify/functions/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}

async function readSession(id) {
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}`, {
    headers: { Authorization: `Bearer ${testKey}` },
  });
  return r.json();
}

console.log("=".repeat(72));
console.log("1. THE $79 ASSESSMENT (gfvc, mode=payment)");
console.log("=".repeat(72));
const gfvc = await mint({ plan: "gfvc" });
console.log(`   handler -> HTTP ${gfvc.status}`);
check("gfvc session was created", gfvc.status === 200 && !!gfvc.json.clientSecret,
  JSON.stringify(gfvc.json).slice(0, 300));

if (gfvc.json.clientSecret) {
  const sid = gfvc.json.clientSecret.split("_secret_")[0];
  const s = await readSession(sid);
  console.log(`   session ${s.id} livemode=${s.livemode} mode=${s.mode} amount=${s.amount_total}`);
  check("test mode, so no real money could move", s.livemode === false);
  check("billing address is REQUIRED", s.billing_address_collection === "required",
    `got ${s.billing_address_collection}`);
  const po = (s.custom_fields || []).find((f) => f.key === "po_number");
  check("a purchase order field exists", !!po, JSON.stringify(s.custom_fields));
  check("the PO field is optional, so it blocks nobody", po && po.optional === true);
  check("the PO field is labelled for a human", po && po.label?.custom === "Purchase order number",
    JSON.stringify(po?.label));
  check("an invoice will be generated", s.invoice_creation?.enabled === true,
    JSON.stringify(s.invoice_creation));
  check("price is still $79", s.amount_total === 7900, String(s.amount_total));
}

console.log();
console.log("=".repeat(72));
console.log("2. CONTROL: the $159 subscription must still work");
console.log("=".repeat(72));
console.log("   Stripe REJECTS invoice_creation on mode=subscription. If the gate above");
console.log("   were wrong this call would fail, so a green $79 alone proves nothing.");
const ss = await mint({ plan: "self_serve" });
console.log(`   handler -> HTTP ${ss.status}`);
check("self_serve session still mints", ss.status === 200 && !!ss.json.clientSecret,
  JSON.stringify(ss.json).slice(0, 300));
if (ss.json.clientSecret) {
  const s2 = await readSession(ss.json.clientSecret.split("_secret_")[0]);
  check("  subscription carries NO invoice_creation", !s2.invoice_creation,
    JSON.stringify(s2.invoice_creation));
  check("  subscription still collects the address and PO",
    s2.billing_address_collection === "required" &&
    (s2.custom_fields || []).some((f) => f.key === "po_number"));
  check("  price is still $159/mo", s2.amount_total === 15900, String(s2.amount_total));
}

console.log();
console.log("=".repeat(72));
console.log("3. CONTROL: a bad plan must still be refused");
console.log("=".repeat(72));
const bad = await mint({ plan: "not_a_real_plan" });
check("invalid plan still 400s", bad.status === 400, `got ${bad.status}`);

console.log();
console.log("=".repeat(72));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED. Test mode only; nothing was published and no money moved.");
process.exit(0);
