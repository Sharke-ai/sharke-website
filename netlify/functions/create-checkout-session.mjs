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

  const prices = {
    ed: "price_1TJKNZIGfptARFHlZbLdWWzK",
    gw: "price_1TJKOGIGfptARFHllj5VyBdo",
    grb: "price_1THu9XIGfptARFHlaeWt01oW",
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

  // GRB and the GFVC Assessment are one-time payments; ed/gw/self_serve/dfy are subscriptions
  const mode = (plan === "grb" || plan === "gfvc") ? "payment" : "subscription";

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
  // GRB ($49 grant verdict) -> /review, GFVC Assessment ($79 org-level) -> /check-intake.
  // DFY is the exception among subscriptions: fulfillment is run by the Sharke
  // team, so it returns to its own marketing-site intake, not app signup.
  const returnUrl = plan === "grb"
    ? `https://sharke.ai/review?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`
    : plan === "gfvc"
    ? `https://sharke.ai/check-intake?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`
    : isDfy
    ? `https://sharke.ai/office-intake?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`
    : `https://sharke-app.netlify.app/signup?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`;
  params.append("return_url", returnUrl);
  params.append("metadata[plan]", plan);
  if (isDfy) {
    params.append("metadata[tier]", tier);
    // Session metadata does NOT propagate to the Subscription object; label the
    // subscription itself so the dashboard tier-change step (and the future
    // MP-1 webhook) can read plan/tier without digging up the session.
    params.append("subscription_data[metadata][plan]", plan);
    params.append("subscription_data[metadata][tier]", tier);
  }

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
