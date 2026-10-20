/**
 * R8 (2026-10-20): retired plans reject, and one $79 Assessment credits one subscription.
 *
 *   node tests/r8_retired_plans_credit_once.test.mjs
 *
 * Stripe is MOCKED (globalThis.fetch). No key, no network, no money. What this proves is the
 * function's decisions given Stripe's answers; the coupon mechanic itself is proven by
 * credit_coupon.test.mjs in test mode.
 */
process.env.STRIPE_SECRET_KEY = "sk_test_mock_not_a_key";
const { default: handler } = await import("../netlify/functions/create-checkout-session.mjs");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${ok ? "" : `\n       -> ${detail}`}`);
  if (!ok) failures++;
};

// Mock Stripe. searchResult: array of prior subscriptions for the credit search, or "error".
function mockStripe({ searchResult = [], assessmentPaid = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body || "" });
    const u = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    if (u.startsWith("https://api.stripe.com/v1/subscriptions/search")) {
      return searchResult === "error" ? json({ error: { message: "down" } }, 500) : json({ data: searchResult });
    }
    if (u.startsWith("https://api.stripe.com/v1/checkout/sessions/")) {
      return json(assessmentPaid
        ? { payment_status: "paid", mode: "payment", metadata: { plan: "gfvc" } }
        : { payment_status: "unpaid", mode: "payment", metadata: { plan: "gfvc" } });
    }
    if (u === "https://api.stripe.com/v1/checkout/sessions" && init.method === "POST") {
      return json({ id: "cs_test_new", client_secret: "secret_x" });
    }
    return json({ error: { message: "unexpected " + u } }, 404);
  };
  return calls;
}
const post = (body) => handler(new Request("https://sharke.ai/x", { method: "POST", body: JSON.stringify(body) }));
const created = (calls) => calls.find((c) => c.method === "POST" && c.url === "https://api.stripe.com/v1/checkout/sessions");

// 1. Retired plans reject and never reach Stripe.
for (const plan of ["ed", "gw"]) {
  const calls = mockStripe();
  const r = await post({ plan });
  const b = await r.json();
  check(`plan=${plan} rejects with 400 Invalid plan`, r.status === 400 && b.error === "Invalid plan", `${r.status} ${JSON.stringify(b)}`);
  check(`plan=${plan} creates no Stripe session`, !created(calls), JSON.stringify(calls));
}

// 2. Live plans still create a session.
for (const body of [{ plan: "self_serve", tier: "under_1m" }, { plan: "dfy", tier: "half" }, { plan: "gfvc" }]) {
  const calls = mockStripe();
  const r = await post(body);
  check(`plan=${body.plan} still creates a session`, r.status === 200 && !!created(calls), `${r.status}`);
}

const CS = "cs_live_a1b2c3d4e5";
// 3. First use of a paid Assessment: credit applied, session stamped.
{
  const calls = mockStripe({ searchResult: [] });
  const r = await post({ plan: "self_serve", tier: "under_1m", credit_session: CS });
  const b = await r.json();
  const c = created(calls);
  check("unused paid Assessment: creditApplied true", b.creditApplied === true, JSON.stringify(b));
  check("unused paid Assessment: coupon and credit_session sent", !!c && c.body.includes("discounts%5B0%5D%5Bcoupon%5D=GFVA_CREDIT_79") && c.body.includes("subscription_data%5Bmetadata%5D%5Bcredit_session%5D=" + CS), c && c.body);
  const s = calls.find((x) => x.url.startsWith("https://api.stripe.com/v1/subscriptions/search"));
  check("search queries metadata credit_session for this session", !!s && decodeURIComponent(s.url).includes(`metadata['credit_session']:'${CS}'`), s && s.url);
}
// 4. Second use (a prior subscription carries it): no credit, full price, sale still made.
{
  const calls = mockStripe({ searchResult: [{ id: "sub_prior", status: "canceled" }] });
  const r = await post({ plan: "self_serve", tier: "under_1m", credit_session: CS });
  const b = await r.json();
  const c = created(calls);
  check("reused Assessment: creditApplied false", r.status === 200 && b.creditApplied === false, JSON.stringify(b));
  check("reused Assessment: no coupon sent, session still created", !!c && !c.body.includes("GFVA_CREDIT_79"), c && c.body);
}
// 5. Search unavailable: fail closed on the credit, open on the sale.
{
  const calls = mockStripe({ searchResult: "error" });
  const r = await post({ plan: "self_serve", tier: "under_1m", credit_session: CS });
  const b = await r.json();
  check("search error: no credit, sale proceeds", r.status === 200 && b.creditApplied === false && !created(calls).body.includes("GFVA_CREDIT_79"), JSON.stringify(b));
}
// 6. Unpaid Assessment never reaches the search and gets no credit.
{
  const calls = mockStripe({ assessmentPaid: false });
  const r = await post({ plan: "self_serve", tier: "under_1m", credit_session: CS });
  const b = await r.json();
  check("unpaid Assessment: no credit, no search", b.creditApplied === false && !calls.some((x) => x.url.includes("/subscriptions/search")), JSON.stringify(b));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
