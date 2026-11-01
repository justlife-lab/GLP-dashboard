/* ============================================================================
 * Frontend configuration – the ONLY file you edit after deploying.
 * Nothing here is secret: the OAuth Client ID and the Web App URL are public
 * identifiers. Passwords, the pepper and all permissions live server-side in
 * Google Apps Script.
 * ========================================================================== */
window.APP_CONFIG = {
  // Apps Script → Deploy → Manage deployments → Web app URL (ends with /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbwvE6vZj5S_W9KHimeUDKk9krxjjb_Qe9cOXroYQtgpsNN_1eNAVXevWWDWI0enxMg/exec',

  // Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web)
  GOOGLE_CLIENT_ID: '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',

  APP_NAME: 'GLP-1 Care CRM',
  ORG_NAME: 'Justlife Healthcare',
  REQUEST_TIMEOUT_MS: 45000
};
