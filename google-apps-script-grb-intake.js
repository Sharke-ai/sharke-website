/**
 * Google Apps Script — GRB Intake Form to Google Sheet
 *
 * SETUP INSTRUCTIONS:
 * 1. Create a new Google Sheet
 * 2. Name the first sheet "Intake"
 * 3. Add these headers in row 1:
 *    A: Timestamp | B: Stripe Session ID | C: Plan | D: First Name | E: Last Name
 *    F: Email | G: Organization | H: State | I: Website | J: Program Summary
 *    K: Funder Name | L: Funder Type | M: CFDA | N: Grants.gov ID
 *    O: Funder State | P: Search Keyword | Q: Grant Title | R: Grant Stage
 *    S: Status
 *
 * 4. Open Extensions > Apps Script
 * 5. Paste this entire file into Code.gs (replace any existing code)
 * 6. Click Deploy > New deployment
 * 7. Type: Web app
 * 8. Execute as: Me
 * 9. Who has access: Anyone
 * 10. Click Deploy, authorize when prompted
 * 11. Copy the Web app URL
 * 12. Paste it into review.html replacing REPLACE_WITH_APPS_SCRIPT_WEB_APP_URL
 */

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Intake");
    if (!sheet) {
      sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    }

    var data = JSON.parse(e.postData.contents);

    sheet.appendRow([
      new Date().toISOString(),           // Timestamp
      data.stripe_session_id || "",       // Stripe Session ID
      data.plan || "",                    // Plan
      data.first_name || "",              // First Name
      data.last_name || "",               // Last Name
      data.email || "",                   // Email
      data.org_name || "",                // Organization
      data.org_state || "",               // State
      data.org_website || "",             // Website
      data.program_summary || "",         // Program Summary
      data.funder_name || "",             // Funder Name
      data.funder_type || "",             // Funder Type
      data.cfda || "",                    // CFDA
      data.grants_gov_id || "",           // Grants.gov ID
      data.funder_state || "",            // Funder State
      data.search_keyword || "",          // Search Keyword
      data.grant_title || "",             // Grant Title
      data.grant_stage || "",             // Grant Stage
      "submitted"                         // Status
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Required for CORS preflight (though no-cors mode skips this)
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "GRB Intake endpoint is live" }))
    .setMimeType(ContentService.MimeType.JSON);
}
