// Relays the /check-intake form to the Google Apps Script intake sheet
// SERVER-SIDE, so the browser gets a real success/failure verdict instead of
// the opaque no-cors response that used to show "success" even when the row
// never landed. The 48-hour clock starts at submit; a silently lost intake is
// a refund, so this function only reports ok:true after Google acknowledges.
const GOOGLE_SHEET_URL =
  "https://script.google.com/macros/s/AKfycbxcV9lFHnJ-41TOTZRn2hJYSb2vj_vbXMvVUFA9z_Ao_ILu_Tt7e-lAUM1a3qXYKDrZVg/exec";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (payload && payload.warm === true) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Minimal sanity gate so junk POSTs don't append blank rows.
  if (!payload || !payload.email || !payload.org_name) {
    return new Response(JSON.stringify({ ok: false, error: "Missing required fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 8s, not 20s: a Netlify function is killed at 10s, so a 20s abort never
  // fires and the platform's generic failure replaces our own error path.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Apps Script answers with a 302 to script.googleusercontent.com; fetch
    // follows it.
    // ⛔ A 2xx proves ONLY that Google replied. ContentService ALWAYS returns
    // HTTP 200, including from doPost's own catch branch, so a failed
    // appendRow arrives here as a 200 carrying {"status":"error"}. A stale
    // deployment URL likewise serves an HTML sign-in page with a 200. The row
    // append is confirmed by the BODY and by nothing else. The buyer has
    // already paid at this point (the payload carries stripe_session_id), so
    // a false ok:true takes money and records no order.
    const res = await fetch(GOOGLE_SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.error("[submit-intake] non-2xx from intake store", res.status);
      return new Response(
        JSON.stringify({ ok: false, error: "Intake store rejected the submission (" + res.status + ")" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const raw = await res.text();
    let verdict;
    try {
      verdict = JSON.parse(raw);
    } catch {
      // Not JSON. Almost always Google serving an HTML sign-in or error page
      // with a 200, which means the deployment URL is stale or its access
      // changed. No row was written.
      console.error("[submit-intake] unreadable body from intake store", raw.slice(0, 300));
      return new Response(
        JSON.stringify({ ok: false, error: "Intake store returned an unreadable response" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!verdict || verdict.status !== "success") {
      // Real reason to the log, generic message to the buyer. Never render an
      // upstream exception into anything a customer reads.
      console.error(
        "[submit-intake] intake store did not record the row",
        JSON.stringify({ verdict, session: payload.stripe_session_id || null, email: payload.email })
      );
      return new Response(
        JSON.stringify({ ok: false, error: "Intake store did not record the submission" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // duplicate:true means this stripe_session_id was already recorded. The
    // order exists, so this is a success for the buyer, not a second row.
    const duplicate = verdict.duplicate === true;
    if (duplicate) {
      console.warn("[submit-intake] duplicate submission for", payload.stripe_session_id || "(no session)");
    }

    // `duplicate` is echoed so the de-duplication can be verified from outside
    // without opening the sheet. Callers key on ok === true and ignore it.
    return new Response(JSON.stringify({ ok: true, duplicate }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err && err.name === "AbortError" ? "timeout" : "network error";
    return new Response(JSON.stringify({ ok: false, error: "Could not reach the intake store (" + reason + ")" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
};
