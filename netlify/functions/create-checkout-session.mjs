export default async (req) => {
  // Only allow POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return new Response(
      JSON.stringify({ error: "Stripe is not configured. Please contact support." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Warm-up ping: sales pages fire this as the offer scrolls into view so the
  // function container is hot before the buyer clicks. No Stripe call is made.
  if (body && body.warm === true) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { plan, tier } = body;

  // COUNTABILITY 2026-08-14, option C. The funnel labels the page keeps in
  // sessionStorage are stamped into Stripe session metadata so they survive the
  // cross-origin hop to app signup, which sessionStorage cannot. Validated
  // against the SAME shapes track.mjs enforces, so nothing reaches the counter
  // that the counter would have rejected. Absent or malformed reads as empty:
  // an unattributed purchase is worth more than an uncounted one.
  const SOURCE_RE = /^[a-z0-9_-]{1,24}$/;
  const VISITOR_RE = /^[a-z0-9]{1,32}$/;
  const funnelSrc = typeof body.s === "string" && SOURCE_RE.test(body.s) ? body.s : "";
  const funnelVid = typeof body.v === "string" && VISITOR_RE.test(body.v) ? body.v : "";

  // grb ($49 Grant Review Brief) retired 2026-07-13; plan=grb now rejects as
  // Invalid plan. session-status.mjs still recognizes historical grb sessions.
  const prices = {
    ed: "price_1TJKNZIGfptARFHlZbLdWWzK",
    gw: "price_1TJKOGIGfptARFHllj5VyBdo",
  };

  // Nonprofit self-serve uses its own inline monthly price with a distinct
  // display name, so the checkout reads "Sharke Self-Serve" (not the
  // grant-writers product) and is never tied to the gw price/amount.
  // The amount is REVENUE-TIERED per D123 (2026-08-20), superseding the flat
  // $159 of the 2026-07-13 pricing canon. Still no scheduled increase: D103
  // bars a price deadline on any surface.
  // GFVC = the Grant Funding Viability Assessment, an inline $79 one-time price.
  // DFY = the done-for-you grant office, an inline monthly subscription priced
  // by the buyer's self-selected tier (share of mission income from grants).
  // Tier is validated for membership only; truthfulness is intentionally
  // unenforced (honor system per the 2026-07-16 no-true-up decision; the
  // month-1 evidence read is the correction mechanism).
  const isSelfServe = plan === "self_serve";
  const isGfvc = plan === "gfvc";
  const isDfy = plan === "dfy";
  const DFY_TIERS = { half: 24900, three_quarters: 36900, all: 45900 };

  // D123 (founder 2026-08-20): self-serve is revenue-tiered, month to month.
  // Under $1M: $99. $1M to $3M: $159. OVER $3M has NO self-serve tier and never
  // reaches this checkout: grant-director.html routes those buyers to /grant-office,
  // because a third self-serve tier would sit under the office's middle tier and
  // invert the ladder. There is deliberately no over_3m key here, so an attempt to
  // buy one is an explicit 400 rather than a silent charge at the wrong price.
  const SELF_SERVE_TIERS = { under_1m: 9900, one_to_three_m: 15900 };
  const priceId = prices[plan];
  if (!priceId && !isSelfServe && !isGfvc && !isDfy) {
    return new Response(JSON.stringify({ error: "Invalid plan" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (isDfy && !Object.prototype.hasOwnProperty.call(DFY_TIERS, tier)) {
    return new Response(JSON.stringify({ error: "Invalid tier" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // A self-serve tier is validated only when one is SENT. A missing tier falls back to
  // $159, which is exactly what the page charged before D123, so a browser holding the
  // pre-D123 page cached still checks out at the price that page displays. Rejecting a
  // missing tier would break those visitors; rejecting a WRONG one is still correct.
  const ssTier = isSelfServe && tier ? tier : null;
  if (isSelfServe && ssTier && !Object.prototype.hasOwnProperty.call(SELF_SERVE_TIERS, ssTier)) {
    return new Response(JSON.stringify({ error: "Invalid tier" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const ssAmount = ssTier ? SELF_SERVE_TIERS[ssTier] : SELF_SERVE_TIERS.one_to_three_m;

  // ---- D121 credit: the $79 Assessment applies to the first subscription month ----
  // Founder 2026-08-20: "We will let the customer apply the $79 spent to their first
  // month should they choose to subscribe."
  //
  // The credit is claimed by passing the Stripe checkout session id of the Assessment
  // the buyer already paid for. That id is the proof, and it is verified AGAINST STRIPE
  // here rather than trusted from the browser: a forged id fails the lookup, and an
  // unpaid or non-Assessment session fails the checks. This needs no new datastore,
  // which is why it is the id and not the email that travels.
  //
  // KNOWN BOUND, deliberately not solved here: nothing stops the same Assessment session
  // being credited twice if a buyer subscribes, cancels and subscribes again. Detecting
  // that needs a store of spent credits. The session id is stamped into the subscription
  // metadata below so a duplicate is at least visible after the fact.
  const CREDIT_COUPON = "GFVA_CREDIT_79";
  let creditApplied = false;
  const creditSession = typeof body.credit_session === "string" ? body.credit_session.trim() : "";
  if (creditSession && plan !== "gfvc" && /^cs_(live|test)_[A-Za-z0-9]+$/.test(creditSession)) {
    try {
      const look = await fetch(
        "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(creditSession),
        { headers: { Authorization: "Bearer " + STRIPE_SECRET_KEY } }
      );
      if (look.ok) {
        const paid = await look.json();
        creditApplied = paid.payment_status === "paid" &&
                        paid.mode === "payment" &&
                        paid.metadata &&
                        paid.metadata.plan === "gfvc";
      }
    } catch {
      // A credit lookup must never block a sale. Full price is recoverable;
      // a checkout that will not mint is not.
      creditApplied = false;
    }
  }

  // The GFVC Assessment is a one-time payment; ed/gw/self_serve/dfy are subscriptions
  const mode = plan === "gfvc" ? "payment" : "subscription";

  // Build Stripe API request (form-encoded)
  const params = new URLSearchParams();
  params.append("mode", mode);
  params.append("ui_mode", "embedded");
  if (isSelfServe) {
    // Inline tiered monthly price (D123), named for the checkout header
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(ssAmount));
    params.append("line_items[0][price_data][recurring][interval]", "month");
    params.append("line_items[0][price_data][product_data][name]", "Sharke Self-Serve");
  } else if (isGfvc) {
    // Inline $79.00 one-time price for the Grant Funding Viability Assessment
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", "7900");
    params.append("line_items[0][price_data][product_data][name]", "Grant Funding Viability Assessment");
  } else if (isDfy) {
    // Inline monthly price for the done-for-you grant office, by selected tier
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(DFY_TIERS[tier]));
    params.append("line_items[0][price_data][recurring][interval]", "month");
    params.append("line_items[0][price_data][product_data][name]", "Sharke Grant Office");
  } else {
    params.append("line_items[0][price]", priceId);
  }
  params.append("line_items[0][quantity]", "1");
  // Subscriptions go to MVP signup; one-time products go to their own intake:
  // GFVC Assessment ($79 org-level) -> /check-intake.
  // DFY is the exception among subscriptions: fulfillment is run by the Sharke
  // team, so it returns to its own marketing-site intake, not app signup.
  const returnUrl = plan === "gfvc"
    ? `https://sharke.ai/check-intake?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`
    : isDfy
    ? `https://sharke.ai/office-intake?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`
    : `https://sharke-app.netlify.app/signup?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`;
  params.append("return_url", returnUrl);
  params.append("metadata[plan]", plan);
  if (funnelSrc) params.append("metadata[src]", funnelSrc);
  if (funnelVid) params.append("metadata[vid]", funnelVid);
  if (isSelfServe && ssTier) {
    params.append("metadata[tier]", ssTier);
    params.append("subscription_data[metadata][plan]", plan);
    params.append("subscription_data[metadata][tier]", ssTier);
  }
  if (isDfy) {
    params.append("metadata[tier]", tier);
    // Session metadata does NOT propagate to the Subscription object; label the
    // subscription itself so the dashboard tier-change step (and the future
    // MP-1 webhook) can read plan/tier without digging up the session.
    params.append("subscription_data[metadata][plan]", plan);
    params.append("subscription_data[metadata][tier]", tier);
  }

  if (creditApplied) {
    params.append("discounts[0][coupon]", CREDIT_COUPON);
    params.append("metadata[credit_session]", creditSession);
    params.append("subscription_data[metadata][credit_session]", creditSession);
  }

  // Purchasing mechanics for a nonprofit buyer (founder 2026-08-19).
  //
  // Before this, the checkout collected a card and nothing else, so an organization
  // that pays against a purchase order, or whose finance office needs an invoice to
  // file, could not complete the purchase at all and the site offered no fallback on
  // any page. That is an excluded buyer, not a lost one.
  //
  // 1. Billing address is REQUIRED. Card processing wants it for AVS anyway, and the
  //    invoice below is not worth much to a finance office without an address on it.
  params.append("billing_address_collection", "required");

  // 2. Purchase order number, OPTIONAL, on every plan. A buyer who does not use POs
  //    sees one extra field they can skip; a buyer who needs one can no longer be
  //    blocked by its absence. Stripe caps custom_fields at 3 and the label at 50
  //    characters. The value lands on the session and on the invoice.
  params.append("custom_fields[0][key]", "po_number");
  params.append("custom_fields[0][type]", "text");
  params.append("custom_fields[0][label][type]", "custom");
  params.append("custom_fields[0][label][custom]", "Purchase order number");
  params.append("custom_fields[0][optional]", "true");

  // 3. Invoice. Stripe only accepts invoice_creation on mode=payment; subscriptions
  //    already generate an invoice per cycle on their own, so setting it there is an
  //    API error rather than a no-op. Today that means the $79 Assessment.
  if (mode === "payment") {
    params.append("invoice_creation[enabled]", "true");
  }

  // W-9 and tax ID are deliberately NOT collected here (founder 2026-08-19: hold).
  // If that changes, tax_id_collection[enabled] is the switch.

  // Branding -- self-serve and the grant office use the light editorial theme
  // (their checkouts mount in a light card); others stay dark
  params.append("branding_settings[background_color]", (isSelfServe || isDfy) ? "#faf8f4" : "#0a0a0a");
  params.append("branding_settings[button_color]", "#c0392b");
  params.append("branding_settings[font_family]", "inconsolata");
  params.append("branding_settings[border_style]", "rectangular");
  params.append("branding_settings[display_name]", "Sharke.ai");

  try {
    const stripeResp = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    const session = await stripeResp.json();

    if (session.error) {
      console.error("Stripe error:", session.error);
      return new Response(
        JSON.stringify({ error: session.error.message }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // creditApplied is reported back so the page can say whether the $79 came off.
    // A buyer who was promised a credit and silently paid full price is a refund
    // request; telling the page lets it show the truth either way.
    return new Response(
      JSON.stringify({ clientSecret: session.client_secret, creditApplied: creditApplied }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Stripe request failed:", err);
    return new Response(
      JSON.stringify({ error: "Payment service unavailable" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
};
