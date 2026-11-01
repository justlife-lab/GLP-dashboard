# Justlife Healthcare – GLP-1 Client Management, Partner CRM & Refill Tracking

A complete Admin + Partner CRM. **GitHub Pages** hosts the frontend, **Google Apps Script** is the secured API, and **Google Sheets** is the single source of truth.

---

## 1. Architecture

```
 Partner browser (partner.html)          Justlife admin browser (index.html)
   username + password                     Google Sign-In (@justlife.com)
            │                                        │ Google ID token
            └──────────── HTTPS POST (JSON, text/plain) ────────────┘
                                   │  { action, payload, token, requestId }
                    Google Apps Script Web App  (code.js → Code.gs)
                    • router: every action has an allowed-role list
                    • session check on every call (re-validates user + company status)
                    • partner calls are hard-pinned to the user's own Company_ID
                    • LockService on every write · idempotency keys · audit log
                                   │ batch getValues / setValues
                    Google Sheet (private, shared with nobody)
                    14 tabs – the database
```

**Why this is secure even though the frontend is public**
- The Sheet is never shared. Only the Apps Script (running as the owner) can read it.
- The frontend never decides permissions. Every call carries a session token; the backend looks up the user, role and company and filters/refuses on the server.
- Admin login: Google returns a signed ID token → backend verifies it with Google (`tokeninfo`), checks `aud` = your Client ID, `email_verified`, `hd` = `justlife.com`, **and** that the email is an *Active* row in `Admin_Users`.
- Partner login: passwords are stored as **PBKDF2-HMAC-SHA256** (random 16-byte salt, configurable iterations, plus a server-side *pepper* in Script Properties). They are never stored in plain text. Logins are rate-limited (5 failures → 15-minute lock).
- Sessions: random 256-bit tokens. Only their SHA-256 hash is stored server-side (CacheService). They expire after `SESSION_TTL_MINUTES` (max 6 h). Deactivating a user, admin or company ends their access on their next request.
- XSS: all output is HTML-escaped, there are no inline handlers, and a strict Content-Security-Policy is set. Formula/CSV injection is neutralised both in the Sheet and in exports.

## 2. Files

| File | Where it lives | Purpose |
|---|---|---|
| `index.html` | GitHub Pages | Admin dashboard (Google Sign-In) |
| `partner.html` | GitHub Pages | Partner dashboard (username/password) |
| `app.js` | GitHub Pages | All frontend logic for both portals (views, forms, charts, exports) |
| `style.css` | GitHub Pages | Shared responsive design |
| `config.js` | GitHub Pages | **Only file you edit**: API URL + Google Client ID (public values, no secrets) |
| `.nojekyll` | GitHub Pages | Tells GitHub Pages to serve files as-is |
| `code.js` | **Apps Script** (paste as `Code.gs`) | Complete backend. Kept in the repo for version control only. |
| `appsscript.json` | **Apps Script** manifest | Time zone, V8 runtime, scopes, web-app access |
| `tests/` | local only | Apps Script emulator + 26 backend tests + 27 browser tests |

## 3. Database (Google Sheet tabs)

All cells are stored as plain text: dates as `yyyy-MM-dd`, timestamps as ISO-8601. IDs are permanent prefixed IDs (e.g. `CLT-261101-7BBB970A`), never row numbers. Dropdown validation is applied to the status columns.

| Sheet | Key | Important columns / relationships |
|---|---|---|
| Admin_Users | Admin_ID | Email (unique, @justlife.com), Role (Super Admin/Admin), Status |
| Companies | Company_ID | Company_Name (unique), contact, Status |
| Partner_Users | User_ID | **Company_ID → Companies**, Username (unique), Password_Hash (PBKDF2), Status, Must_Change_Password, Failed_Attempts, Locked_Until |
| Clients | Client_ID | **Company_ID**, External_Client_ID (unique per company), First_Booking_Ref, Registration_Date (auto), Journey_Start_Date, height/weight/BMI, Initial_* medication (never overwritten), Current_* medication, Refill_Interval_Days, Created_By |
| Client_Journeys | Journey_ID | **Client_ID** (1:1), Start/Expected_End_Date, Duration_Months, Status (Active/Paused/Stopped/Completed), Completion_Confirmed(+By/At/Note) |
| Refill_Schedule | Schedule_ID | **Client_ID, Journey_ID**, Cycle_Number, **Original_Expected_Date** (never changes), Current_Expected_Date, Status (Scheduled/Completed/Cancelled), Reschedule_Count, Completed_Refill_ID |
| Refill_Records | Refill_ID | **Client_ID, Schedule_ID**, Cycle_Number, Refill_Date, Expected_Date, Timing (Early/On time/Late), Booking_Ref, full medication snapshot, *_Changed flags, payment fields, **Transaction_ID**, Doctor/Partner notes, Next_Refill_Date |
| Payment_Transactions | Transaction_ID | **Client_ID, Company_ID**, Source_Type (REGISTRATION/REFILL) + Source_ID, Transaction_Type, Amount, Payment_Date, Payment_Status, Created_By |
| Doctor_Notes | Note_ID | Client_ID, Related_Type/ID, Doctor_Name |
| Client_Notes | Note_ID | Client_ID, Note_Type (REGISTRATION, REFILL, PARTNER, INTERNAL, STATUS_CHANGE, MEDICATION_CHANGE, RESCHEDULE, COMPLETION, ADMIN_EDIT), Visibility (Shared/Internal) |
| Reschedule_History | Reschedule_ID | Schedule_ID, Original/Previous/New date, reason, who |
| Notifications | Notification_ID | Company_ID, Client_ID, Schedule_ID, Category, **Dedupe_Key** (schedule + category + due date), Read_By, Email_Sent |
| Audit_Logs | Log_ID | Actor, Action, Entity, Before_JSON / After_JSON |
| System_Settings | Setting_Key | All business rules (see §6) |

**Journey logic.** Registration supplies month 1. Refills #1–#5 supply months 2–6. The first refill date is set automatically to start + interval. Each later date is entered on the refill form, defaulting to refill date + interval. Each client has their own interval, and any date can be rescheduled.
- **Progress** = months that are both supplied *and* elapsed ÷ 6, so it uses both dates and recorded milestones.
- **Status** is computed: `Not Started` (start date in the future) · `Active` · `Overdue` (open refill past due + grace days) · `Paused` / `Stopped` (set by an admin) · `Completed`.
- After all 6 months are supplied, a journey shows **Review**. It only becomes `Completed` when an admin confirms it; the passing of time alone never completes it.

## 4. Deployment guide

### A. Database + backend
1. **Create the Google Sheet** in the Justlife Workspace Drive, e.g. "GLP-1 CRM Database". Do **not** share it.
2. **Extensions → Apps Script.** Rename the project "GLP-1 CRM API".
3. **Add the backend files.** Replace `Code.gs` with the full contents of `code.js`. Then open *Project Settings*, tick **Show "appsscript.json"**, and replace that file's contents with this repo's `appsscript.json`. Save.
4. **Script Properties** (Project Settings → Script properties):
   - `BOOTSTRAP_ADMIN_EMAIL` = your @justlife.com email
   - `ALLOWED_ADMIN_DOMAIN` = `justlife.com`
   - `GOOGLE_CLIENT_ID` = (from step 6)
   - optional: `PBKDF2_ITERATIONS` (default 4000; see §7)
   - `PASSWORD_PEPPER` is generated automatically. **Never change it later**, or every partner password stops working.
5. **Initialise the database.** Select `initializeSystem` in the function dropdown → **Run** → approve the permissions. This creates all 14 tabs with headers, validation and default settings, adds you as the first Super Admin, and installs the daily 07:00 reminder trigger. Optionally run `benchmarkPasswordHash` to see how long hashing takes.
6. **Google OAuth Client ID** (Google Cloud Console, in a project owned by the Justlife Workspace):
   1. APIs & Services → **OAuth consent screen** → User type **Internal** (only justlife.com accounts can sign in) → App name, support email → Save. Scopes: just `openid`, `email`, `profile`.
   2. **Credentials → Create credentials → OAuth client ID → Web application.**
   3. **Authorised JavaScript origins:** `https://<your-github-user-or-org>.github.io` (and a custom domain if you use one). No redirect URIs are needed.
   4. Copy the Client ID → put it in Script Property `GOOGLE_CLIENT_ID` **and** in `config.js`.
7. **Deploy → New deployment → Web app.** *Execute as:* **Me**. *Who has access:* **Anyone**. Deploy and copy the URL ending in `/exec`.
   - "Anyone" is required so the GitHub Pages site and partners without Google accounts can call the API. It does **not** expose data: every action except login requires a valid session, and the Sheet itself stays private.
8. **Permissions:** the first run asks for Sheets, external requests (to verify Google tokens), send mail (reminders) and triggers. If your Workspace restricts unverified apps, a **Workspace super-admin** may need to trust the script: Admin console → Security → API controls → *Manage third-party app access* → add the script's OAuth client as **Trusted**. If "Anyone" isn't offered in step 7, Admin console → Apps → Google Workspace → Drive and Docs → *Sharing settings* must allow sharing outside the domain for this OU.

### B. Frontend
9. Create a GitHub repository (it can be private if your plan supports private Pages).
10. Upload `index.html`, `partner.html`, `app.js`, `style.css`, `config.js`, `.nojekyll`. `code.js` and `appsscript.json` can be committed too; they contain no secrets.
11. Settings → **Pages** → Deploy from branch → `main` / root. Wait for the `https://…github.io/<repo>/` URL.
12. Edit `config.js`: `API_URL` = the `/exec` URL, `GOOGLE_CLIENT_ID` = your client ID. Commit.

### C. First use and checks
13. Open `…/index.html` → Sign in with Google using the bootstrap email. Add other admins under **Admin Users**.
14. **Companies & Partners → Add company.**
15. Create the partner logins. A temporary password is shown **once**; send it privately. The user must change it at first sign-in.
16. Test Admin login: a non-listed @justlife.com account and any Gmail account must both be refused.
17. Test Partner login at `…/partner.html`.
18. Test data isolation: create two companies, sign in as each, and confirm neither sees the other's clients.
19. Register a client, check the journey bar, record a refill, and reschedule.
20. **Refills & Reminders → Run reminder check now.** Then check **Upsell & Payments** for the automatic transactions.

**After changing `code.js`:** Deploy → *Manage deployments* → edit the existing deployment → *Version: New version*. This keeps the same URL.

## 5. Feature map

- **Partner:** 9 KPI cards, a reminders panel, and overdue / today / this-week boards. Client search covers name, client ID, booking ref and phone, with filters for medication, injection/pills and status. Other features:
  - registration form with automatic BMI, today's date and company
  - refill form with *No change* option and mandatory note
  - reschedule with reason, keeping full history
  - medication and dosage updates, doctor notes and notes
  - complete client profile: overview, refills, payments, full timeline, notes, reschedules
  - password change
- **Admin:** everything above across all companies, plus:
  - performance dashboard with 13 KPIs, a partner-wise table, 7 charts, date and company filters, and a review queue
  - **Upsell & Payment tracker** with Today / This week / Last week / This month / Last month / Custom presets, company, partner user, medication, type and status filters, daily, weekly and monthly trends, and payment-date correction
  - client, refill and payment correction with mandatory reason and before/after audit
  - pause / stop / reactivate journeys and confirm completion; internal notes hidden from partners
  - companies and partner users: create, edit, reset password, (de)activate
  - admin users, audit log viewer, settings, Excel/CSV export of 8 datasets
- **Reminders:** daily trigger with categories *Overdue · Due today · Due within 3 days · Due this week*. Each reminder is created once per refill cycle and due date. Reminders close when the refill is recorded or rescheduled. Optional partner email digests and an admin overdue digest.

## 6. Settings (System_Settings tab or Admin → Settings)

| Key | Default | Meaning |
|---|---|---|
| JOURNEY_MONTHS | 6 | Journey length for new registrations |
| DEFAULT_REFILL_INTERVAL_DAYS | 30 | Default interval (each client can override) |
| OVERDUE_GRACE_DAYS | 0 | Days after the due date before a refill counts as overdue |
| CONVERSION_MODE | MIN_REFILLS | `MIN_REFILLS` (≥ N refills) or `PAID_REGISTRATION` |
| CONVERSION_MIN_REFILLS | 1 | N |
| CONVERSION_DENOMINATOR | ELIGIBLE | `ELIGIBLE` = only clients whose first refill was already due; `REGISTERED` = all |
| UPSELL_TRANSACTION_TYPES | Refill | Which paid transaction types count as upsell |
| REMINDER_EMAILS_ENABLED | FALSE | Email daily digests to partner users who have an email |
| SESSION_TTL_MINUTES | 240 | Session lifetime (max 360) |

Only **Paid** transactions count as collected revenue. Pending, Failed and Refunded payments are stored and shown but excluded from totals.

## 7. Known limitations (and why)

- **Apps Script throughput.** Each request reads the relevant tabs in one batch. This is comfortable up to a few thousand clients and ~50k rows. Writes are serialised by `LockService`, so many simultaneous saves queue for a few seconds. Beyond that scale, move to a real database (e.g. Cloud SQL / Firestore) behind the same API.
- **Not transactional.** A multi-sheet write that crashes midway (rare) could leave a partial record. Idempotency keys stop double submissions; the audit log shows exactly what was written.
- **Sessions in CacheService.** Google may evict cache entries early; the user then just signs in again. The hard maximum is 6 h.
- **PBKDF2 speed.** Apps Script has no native PBKDF2, so it runs as an HMAC loop. The default is 4000 iterations plus a secret pepper, so a stolen Sheet alone cannot be brute-forced. Raise `PBKDF2_ITERATIONS` while login stays under ~2 s (`benchmarkPasswordHash`). Existing hashes keep working because each hash records its own iteration count.
- **Random numbers.** Salts and tokens are derived from `Utilities.getUuid()` (server-side random UUIDs) hashed with SHA-256. Apps Script has no direct CSPRNG API.
- **No origin check.** Apps Script web apps cannot read request headers, so the API cannot restrict callers to your GitHub domain. Security relies on the session tokens instead, which is the correct control.
- **Public frontend code.** GitHub Pages files are public. They contain no secrets, only the public Client ID and API URL.
- **Medical data.** Google Workspace's terms and your data-protection obligations (e.g. UAE health-data rules) apply to storing PHI in Sheets. Confirm with Justlife compliance. Reminder emails deliberately contain only client name, ID and dates.
- **Clock.** "Today" uses the `TIMEZONE` setting (Asia/Dubai).

## 8. Test report

Tests run locally against an emulator of the Apps Script services (`tests/gas-mock.js`: Sheets, Cache, Lock, Properties, Utilities, UrlFetch, Mail, triggers). The same unmodified `code.js` is executed.

`node tests/backend.test.js` → **26/26 passed**
| Area | Result |
|---|---|
| Setup creates 14 sheets, settings, bootstrap admin, trigger; re-running is safe | ✅ |
| Admin Google login; Gmail, unlisted @justlife.com and forged tokens rejected; admin APIs refuse bad tokens | ✅ |
| Create/deactivate admins (session revoked instantly); cannot deactivate self or last admin | ✅ |
| Companies, multiple logins per company, PBKDF2 hashes (no plain text) | ✅ |
| Partner login, forced temp-password change, lock-out after 5 failures, reset unlocks | ✅ |
| Partners blocked from every admin API; company deactivation blocks sessions; logout | ✅ |
| Registration → 6-month journey, first refill date, payment transaction, notes; duplicate submission returns the same record | ✅ |
| Validation: mandatory note, duplicate client ID, bad enums, missing payment status, formula injection | ✅ |
| **Data isolation:** partner B cannot list/read/refill/reschedule/note company A; spoofed companyId ignored | ✅ |
| Progress bar segments, current month, overdue and not-started statuses | ✅ |
| Delayed refill (Late 45d), early refill (Early 30d), No-change medication, medication + dosage change history | ✅ |
| Reschedule keeps original date and full history; admin-only correction reason | ✅ |
| Doctor notes, internal notes hidden from partners, audit hidden from partners | ✅ |
| Admin edits of client, refill and payment date with before/after audit; refill ↔ payment kept in sync | ✅ |
| Payments: Paid-only revenue, Today / This week / Last week / custom / company / medication / partner-user filters | ✅ |
| Performance report partner table, revenue, configurable conversion denominator | ✅ |
| Reminders: categories, no duplicates on re-run, email digest, auto-resolve after refill, mark read | ✅ |
| Stop / pause / reactivate; refills blocked while stopped or paused | ✅ |
| Full 6 refills → awaiting review → admin confirms (not automatic); partial completion needs override | ✅ |
| Exports (no secrets), every protected route rejects anonymous calls | ✅ |

`node tests/server.js & node tests/ui.test.js` (Chromium via Playwright) → **27/27 passed, 0 JavaScript errors**
- Partner: login, wrong password, forced password change, dashboard, own-company-only list, search + filters, registration form (BMI auto-calc, mandatory note, double-click submits once), reschedule then refill from profile, history tabs, refill board, reminders, admin routes unreachable, **XSS payload rendered as text**, 390 px mobile layout without horizontal scroll, logout.
- Admin: Google button, all 8 views render, cross-company list, profile audit tab, confirm completion, payment presets change totals, create company + partner login (temp password shown once), XLSX export download, mobile dashboard.

**Not testable outside your Google account:** a real Google Sign-In popup, real `tokeninfo` verification, MailApp delivery and the time-driven trigger. Those paths are emulated in the tests. Verify them with deployment steps 16–20.
