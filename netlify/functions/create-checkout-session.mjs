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

  const { plan } = body;

  const prices = {
    ed: "price_1TJKNZIGfptARFHlZbLdWWzK",
    gw: "price_1TJKOGIGfptARFHllj5VyBdo",
    grb: "price_1THu9XIGfptARFHlaeWt01oW",
  };

  // Nonprofit self-serve uses its own inline $159/mo price with a distinct
  // display name, so the checkout reads "Sharke Self-Serve" (not the
  // grant-writers product) and is never tied to the gw price/amount.
  // $159 is the founding-member rate; it steps up to $199/mo on 2026-09-01
  // (handled then, not via a Stripe schedule here).
  // GFVC = the Grant Funding Viability Assessment, an inline $79 one-time price.
  const isSelfServe = plan === "self_serve";
  const isGfvc = plan === "gfvc";
  const priceId = prices[plan];
  if (!priceId && !isSelfServe && !isGfvc) {
    return new Response(JSON.stringify({ error: "Invalid plan" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // GRB and the GFVC Assessment are one-time payments; ed/gw/self_serve are subscriptions
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
  } else {
    params.append("line_items[0][price]", priceId);
  }
  params.append("line_items[0][quantity]", "1");
  // Subscriptions go to MVP signup; one-time products go to their own intake:
  // GRB ($49 grant verdict) -> /review, GFVC Assessment ($79 org-level) -> /check-intake
  const returnUrl = plan === "grb"
    ? `https://sharke.ai/review?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`
    : plan === "gfvc"
    ? `https://sharke.ai/check-intake?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`
    : `https://sharke-app.netlify.app/signup?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`;
  params.append("return_url", returnUrl);
  params.append("metadata[plan]", plan);

  // Branding -- self-serve uses the light editorial theme; others stay dark
  params.append("branding_settings[background_color]", isSelfServe ? "#faf8f4" : "#0a0a0a");
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
