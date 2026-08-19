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

  // Nonprofit self-serve uses its own inline $159/mo price with a distinct
  // display name, so the checkout reads "Sharke Self-Serve" (not the
  // grant-writers product) and is never tied to the gw price/amount.
  // $159/mo is flat per the 2026-07-13 pricing canon; no scheduled increase.
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

  // The GFVC Assessment is a one-time payment; ed/gw/self_serve/dfy are subscriptions
  const mode = plan === "gfvc" ? "payment" : "subscription";

  // Build Stripe API request (form-encoded)
  const params = new URLSearchParams();
  params.append("mode", mode);
  params.append("ui_mode", "embedded");
  if (isSelfServe) {
    // Inline $159.00/month price, named for the checkout header
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", "15900");
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
  if (isDfy) {
    params.append("metadata[tier]", tier);
    // Session metadata does NOT propagate to the Subscription object; label the
    // subscription itself so the dashboard tier-change step (and the future
    // MP-1 webhook) can read plan/tier without digging up the session.
    params.append("subscription_data[metadata][plan]", plan);
    params.append("subscription_data[metadata][tier]", tier);
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

    return new Response(
      JSON.stringify({ clientSecret: session.client_secret }),
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
