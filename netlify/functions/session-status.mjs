// Post-payment session check for the intake pages. The intake page calls this with
// the session_id Stripe put in the return URL; we confirm the payment landed and
// hand back just enough to greet the buyer and prefill the form. Read-only against
// Stripe; returns the minimal field set (never amounts, ids, or card data) and only
// for the one-time intake products (gfvc/grb), so it cannot be used to probe other
// checkout sessions.
export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ paid: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ paid: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sessionId = body && typeof body.session_id === "string" ? body.session_id : "";
  // Checkout session ids: cs_live_... / cs_test_... Reject anything else outright.
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
    return new Response(JSON.stringify({ paid: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const resp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } }
    );
    const session = await resp.json();

    const plan = session && session.metadata ? session.metadata.plan : null;
    const isIntakeProduct = plan === "gfvc" || plan === "grb";
    const paid = isIntakeProduct && session.payment_status === "paid";

    if (!paid) {
      return new Response(JSON.stringify({ paid: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const details = session.customer_details || {};
    return new Response(
      JSON.stringify({
        paid: true,
        email: details.email || session.customer_email || "",
        name: details.name || "",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("session-status error:", err);
    // Fail open: the intake form must never be blocked by this check.
    return new Response(JSON.stringify({ paid: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
};
