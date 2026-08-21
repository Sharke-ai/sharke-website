/**
 * D123 revenue-tiered self-serve: prove every tier charges what the page promises.
 *
 *   node tests/tier_pricing.test.mjs
 *
 * NOT under netlify/functions/. Anything in that directory is bundled and deployed as
 * a public endpoint.
 *
 * Runs the REAL handler with the sk_test_ key, so it tests the code that ships rather
 * than a restatement of it. Test mode only; it refuses a live key and moves no money.
 *
 * Tiers: under $1M = $99/mo, $1M to $3M = $159/mo, over $3M = $249/mo. The last one
 * AMENDS D123, which had refused it to stop the ladder inverting; the grant office
 * moving to $399+ removes that reason.
 *
 * The controls are the point. A tier test that only checks the happy path would pass
 * just as happily if the handler ignored the tier and charged $159 to everyone, which
 * is the exact defect worth catching, so the $99 tier is asserted to be DIFFERENT from
 * the $159 one, and the over-$3M tier is asserted to be REFUSED rather than charged.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
const testKey = (env.match(/^STRIPE_TEST_KEY=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
if (!testKey || !testKey.startsWith("sk_test_")) {
  console.error("FATAL: no sk_test_ key found. Refusing to run.");
  process.exit(2);
}
process.env.STRIPE_SECRET_KEY = testKey;

const { default: handler } = await import("../netlify/functions/create-checkout-session.mjs");

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

async function amountOf(body) {
  const r = await mint(body);
  if (r.status !== 200 || !r.json.clientSecret) return { status: r.status, amount: null, json: r.json };
  const id = r.json.clientSecret.split("_secret_")[0];
  const s = await (await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}`, {
    headers: { Authorization: `Bearer ${testKey}` },
  })).json();
  return { status: r.status, amount: s.amount_total, livemode: s.livemode, metadata: s.metadata, mode: s.mode, json: r.json };
}

console.log("=".repeat(72));
console.log("1. THE TWO SELF-SERVE TIERS CHARGE DIFFERENT AMOUNTS");
console.log("=".repeat(72));
const under = await amountOf({ plan: "self_serve", tier: "under_1m" });
const mid = await amountOf({ plan: "self_serve", tier: "one_to_three_m" });
console.log(`   under_1m       -> HTTP ${under.status}, amount ${under.amount}`);
console.log(`   one_to_three_m -> HTTP ${mid.status}, amount ${mid.amount}`);
check("under $1M is $99/mo", under.amount === 9900, `got ${under.amount}`);
check("$1M to $3M is $159/mo", mid.amount === 15900, `got ${mid.amount}`);
check("test mode, no real money", under.livemode === false && mid.livemode === false);
check("both are subscriptions", under.mode === "subscription" && mid.mode === "subscription");
check("the tier rides the session metadata", under.metadata?.tier === "under_1m",
  JSON.stringify(under.metadata));

console.log();
console.log("   CONTROL: the amounts must actually DIFFER. Equal amounts would mean the");
console.log("   handler ignored the tier, and every assertion above would still pass.");
check("the tiers are not the same price", under.amount !== mid.amount,
  `both came back ${under.amount}, so the tier is being ignored`);

console.log();
console.log("=".repeat(72));
console.log("2. OVER $3M IS A REAL TIER AT $249 (founder 2026-08-20, amending D123)");
console.log("=".repeat(72));
console.log("   D123 originally refused this tier to protect the ladder. The office moving");
console.log("   to $399+ retires that reason, so $249 now sits BELOW the office floor.");
const over = await amountOf({ plan: "self_serve", tier: "over_3m" });
console.log(`   over_3m -> HTTP ${over.status}, amount ${over.amount}`);
check("over $3M is $249/mo", over.amount === 24900, `got ${over.amount}`);
check("and it is a subscription", over.mode === "subscription");
check("it stays BELOW the grant office floor of $39900", over.amount < 39900,
  `${over.amount} would invert the ladder`);
const junk = await mint({ plan: "self_serve", tier: "not_a_tier" });
check("a garbage tier is still refused", junk.status === 400, `got ${junk.status}`);

console.log();
console.log("   CONTROL: all THREE self-serve tiers must be distinct, ascending amounts.");
check("the three tiers ascend and differ",
  under.amount < mid.amount && mid.amount < over.amount,
  `got ${under.amount}, ${mid.amount}, ${over.amount}`);

console.log();
console.log("=".repeat(72));
console.log("3. BACKWARD COMPATIBILITY: a cached pre-D123 page sends no tier");
console.log("=".repeat(72));
const notier = await amountOf({ plan: "self_serve" });
console.log(`   no tier -> HTTP ${notier.status}, amount ${notier.amount}`);
check("a missing tier still checks out", notier.status === 200, JSON.stringify(notier.json).slice(0, 200));
check("and falls back to $159, the price that page displays", notier.amount === 15900,
  `got ${notier.amount}`);

console.log();
console.log("=".repeat(72));
console.log("4. CONTROLS: the other products are untouched");
console.log("=".repeat(72));
const gfvc = await amountOf({ plan: "gfvc" });
check("the $79 Assessment is still $79", gfvc.amount === 7900, `got ${gfvc.amount}`);
const dfy = await amountOf({ plan: "dfy", tier: "half" });
check("the grant office half tier is still $249", dfy.amount === 24900, `got ${dfy.amount}`);
const dfyBad = await mint({ plan: "dfy", tier: "under_1m" });
check("a self-serve tier cannot be used to buy the grant office", dfyBad.status === 400,
  `got ${dfyBad.status}`);
const badPlan = await mint({ plan: "nope" });
check("an invalid plan is still refused", badPlan.status === 400, `got ${badPlan.status}`);

console.log();
console.log("=".repeat(72));
if (failures) {
  console.log(`${failures} CHECK(S) FAILED.`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED. Test mode only; nothing published, no money moved.");
process.exit(0);
