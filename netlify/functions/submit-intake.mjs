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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    // Apps Script answers with a 302 to script.googleusercontent.com; fetch
    // follows it. Any 2xx terminal response = the doPost ran and the row
    // append was reached.
    const res = await fetch(GOOGLE_SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: "Intake store rejected the submission (" + res.status + ")" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
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
