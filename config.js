/* ============================================================================
 * Frontend configuration – the ONLY file you edit after deploying.
 * Nothing here is secret: the OAuth Client ID and the Web App URL are public
 * identifiers. Passwords, the pepper and all permissions live server-side in
 * Google Apps Script.
 * ========================================================================== */
window.APP_CONFIG = {
  // Apps Script → Deploy → Manage deployments → Web app URL (ends with /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbwKp2C7Jj1y7v1DSPAdHI6yf4HL76IPpU65jBPNdrm8K2tM-Qx629vjAnSnZwId8NI/exec',

  // Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web)
        GOOGLE_CLIENT_ID: '243218274694-8s7iv3fqqi3os0cf0a4m1m0j208bpsoe.apps.googleusercontent.com',

  APP_NAME: 'GLP-1 Care CRM',
  ORG_NAME: 'Justlife Healthcare',
  REQUEST_TIMEOUT_MS: 45000
};
