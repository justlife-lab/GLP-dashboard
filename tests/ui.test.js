// Browser test of both portals against the emulated backend.  Run: node server.js & node ui.test.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:8787';
const SHOTS = path.join(__dirname, 'screens');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const errors = [];

async function prep(ctx) {
  await ctx.route('https://cdnjs.cloudflare.com/**', r => {
    const u = r.request().url();
    const f = u.includes('Chart.js') ? 'node_modules/chart.js/dist/chart.umd.js' : 'node_modules/xlsx/dist/xlsx.full.min.js';
    r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(__dirname, f)) });
  });
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('https://accounts.google.com/**', r => r.fulfill({ contentType: 'application/javascript', body: 'window.google={accounts:{id:{initialize(){},renderButton(el){el.innerHTML="<button>Sign in with Google</button>"},disableAutoSelect(){}}}};' }));
}
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); }
}
function watch(page, label) {
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(label + ' console: ' + m.text()); });
}

(async () => {
  const browser = await chromium.launch();
  // ---------------- PARTNER ----------------
  const pctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, bypassCSP: true });
  await prep(pctx);
  const p = await pctx.newPage(); p.setDefaultTimeout(8000); watch(p, 'partner');
  await step('Partner login page renders', async () => { await p.goto(BASE + '/partner.html'); await p.waitForSelector('#partner-login-form'); await p.screenshot({ path: SHOTS + '/p-login.png' }); });
  await step('Wrong password rejected', async () => {
    await p.fill('[name=username]', 'alpha.one'); await p.fill('[name=password]', 'nope-nope-1'); await p.click('button[type=submit]');
    await p.waitForSelector('#login-error:not([hidden])'); if (!/Invalid/.test(await p.textContent('#login-error'))) throw new Error('no error');
  });
  await step('Login with temp password forces password change, then dashboard', async () => {
    await p.fill('[name=password]', 'TempPass123'); await p.click('button[type=submit]');
    await p.waitForSelector('.modal [name=newPassword]');
    await p.fill('.modal [name=currentPassword]', 'TempPass123'); await p.fill('.modal [name=newPassword]', 'AlphaNew1234'); await p.fill('.modal [name=confirm]', 'AlphaNew1234');
    await p.click('.modal [data-submit]');
    await p.waitForSelector('.kpis .kpi'); await p.waitForTimeout(300);
    await p.screenshot({ path: SHOTS + '/p-dashboard.png', fullPage: true });
    const txt = await p.textContent('.kpis');
    if (!/Total registered clients/.test(txt) || !/Overdue refills/.test(txt)) throw new Error('kpis missing');
  });
  await step('Client list shows only own company + progress bars', async () => {
    await p.click('[data-nav=clients]'); await p.waitForSelector('#client-table table');
    const rows = await p.$$eval('#client-table tbody tr', r => r.map(x => x.textContent));
    if (rows.some(t => /Yousef|Maria|Daniel/.test(t))) throw new Error('other company visible');
    if (rows.length !== 7) throw new Error('expected 7 rows, got ' + rows.length);
    if (!(await p.$('.journey-segs .seg-done'))) throw new Error('no progress');
    await p.screenshot({ path: SHOTS + '/p-clients.png', fullPage: true });
  });
  await step('Search + status filter', async () => {
    await p.fill('[name=q]', 'BK-9101'); await p.waitForTimeout(700);
    let n = await p.$$eval('#client-table tbody tr', r => r.length); if (n !== 1) throw new Error('search rows ' + n);
    await p.fill('[name=q]', ''); await p.selectOption('[name=status]', 'Overdue'); await p.waitForTimeout(700);
    const t = await p.textContent('#client-table'); if (!/Overdue/.test(t)) throw new Error('no overdue');
    await p.selectOption('[name=status]', ''); await p.waitForTimeout(500);
  });
  await step('Register new client via form (BMI auto-calc, idempotent submit)', async () => {
    await p.click('[data-action=register-client]'); await p.waitForSelector('.modal [name=fullName]');
    const f = async (n, v) => p.fill('.modal [name=' + n + ']', v);
    await f('fullName', 'Test Browser Client'); await f('phone', '+971 55 777 8888'); await f('externalClientId', 'JL-UI-1'); await f('firstBookingRef', 'BK-UI-1');
    await f('heightCm', '170'); await f('weightKg', '95');
    const bmi = await p.inputValue('.modal [name=bmi]'); if (bmi !== '32.9') throw new Error('bmi ' + bmi);
    await p.selectOption('.modal [name=medicationType]', 'Injection'); await p.selectOption('.modal [name=medicationName]', 'Ozempic (Semaglutide)');
    await f('prescribedDosage', '1 mg'); await f('startingDosage', '0.25 mg'); await f('quantity', '1 pen');
    await f('amountCollected', '1100');
    await p.click('.modal [data-submit]');
    await p.waitForSelector('.modal [data-form-error]:not([hidden])'); // mandatory note missing
    await f('partnerNotes', 'Registered via UI test');
    await p.screenshot({ path: SHOTS + '/p-register.png', fullPage: true });
    await Promise.all([p.click('.modal [data-submit]'), p.click('.modal [data-submit]').catch(() => {})]); // double click
    await p.waitForSelector('#profile-tab'); await p.waitForTimeout(300);
    const h = await p.textContent('.modal-head h2'); if (!/Test Browser Client/.test(h)) throw new Error('profile not opened');
    await p.screenshot({ path: SHOTS + '/p-profile.png', fullPage: true });
  });
  await step('Record refill with No Change from profile', async () => {
    await p.click('[data-p=reschedule]'); await p.waitForSelector('.modal [name=newDate]');
    const t = await p.evaluate(() => new Date().toISOString().slice(0, 10));
    await p.fill('.modal [name=newDate]', t); await p.selectOption('.modal [name=reasonCategory]', 'Early refill needed'); await p.fill('.modal [name=note]', 'Needs it early');
    await p.click('.modal-backdrop:last-child [data-submit]'); await p.waitForTimeout(600);
    await p.click('[data-p=refill]'); await p.waitForSelector('.modal [name=bookingRef]');
    if (!(await p.isDisabled('.modal-backdrop:last-child [name=dosage]'))) throw new Error('no-change should disable dosage');
    await p.fill('.modal-backdrop:last-child [name=bookingRef]', 'BK-UI-2'); await p.fill('.modal-backdrop:last-child [name=quantity]', '1 pen');
    await p.fill('.modal-backdrop:last-child [name=amountCollected]', '650'); await p.fill('.modal-backdrop:last-child [name=partnerNotes]', 'First refill (UI)');
    await p.screenshot({ path: SHOTS + '/p-refill.png', fullPage: true });
    await p.click('.modal-backdrop:last-child [data-submit]'); await p.waitForTimeout(800);
    await p.click('[data-tab=refills]'); await p.waitForTimeout(200);
    const tt = await p.textContent('#profile-tab'); if (!/BK-UI-2/.test(tt) || !/Early/.test(tt)) throw new Error('refill not in history');
    await p.click('[data-tab=timeline]'); await p.screenshot({ path: SHOTS + '/p-timeline.png', fullPage: true });
    await p.click('.modal-backdrop [data-close]');
  });
  await step('Refills board + reminders page', async () => {
    await p.click('[data-nav=refills]'); await p.waitForSelector('.board'); await p.screenshot({ path: SHOTS + '/p-refills.png', fullPage: true });
    await p.click('[data-nav=notifications]'); await p.waitForSelector('.kpis'); await p.screenshot({ path: SHOTS + '/p-notifications.png', fullPage: true });
  });
  await step('Partner cannot see admin views (routes fall back to dashboard)', async () => {
    await p.goto(BASE + '/partner.html#/payments'); await p.waitForSelector('.kpis');
    if ((await p.textContent('#view-title')) !== 'Dashboard') throw new Error('admin view reachable');
  });
  await step('XSS: script in client name is rendered as text', async () => {
    const ok = await p.evaluate(async () => {
      const token = sessionStorage.getItem('glp_session_partner');
      const r = await fetch('/api', { method: 'POST', body: JSON.stringify({ action: 'client.register', token, requestId: crypto.randomUUID(), payload: { fullName: '<img src=x onerror="window.__xss=1">', phone: '+971501112233', externalClientId: 'XSS-1', firstBookingRef: 'B', journeyStartDate: new Date().toISOString().slice(0, 10), heightCm: 170, weightKg: 80, medicationType: 'Pills', medicationName: 'Other', prescribedDosage: '1', startingDosage: '1', quantity: '1', partnerNotes: 'x' } }) });
      return (await r.json()).ok;
    });
    if (!ok) throw new Error('register failed');
    await p.click('[data-nav=clients]'); await p.waitForSelector('#client-table table'); await p.waitForTimeout(300);
    if (await p.evaluate(() => window.__xss)) throw new Error('XSS executed');
    if (await p.$('#client-table img')) throw new Error('img injected');
  });
  await step('Mobile partner layout (390px) – no horizontal page scroll', async () => {
    const m = await pctx.newPage(); m.setDefaultTimeout(8000); watch(m, 'mobile');
    await m.setViewportSize({ width: 390, height: 844 });
    await m.goto(BASE + '/partner.html'); const tk = await p.evaluate(() => sessionStorage.getItem('glp_session_partner')); await m.evaluate(t => sessionStorage.setItem('glp_session_partner', t), tk); await m.goto(BASE + '/partner.html#/dashboard'); await m.reload(); await m.waitForSelector('.kpis');
    const sw = await m.evaluate(() => document.documentElement.scrollWidth); if (sw > 392) throw new Error('scrollWidth ' + sw);
    await m.screenshot({ path: SHOTS + '/m-dashboard.png', fullPage: true });
    await m.click('.menu-btn'); await m.waitForTimeout(300); await m.screenshot({ path: SHOTS + '/m-menu.png' });
    await m.click('[data-nav=clients]'); await m.waitForSelector('#client-table table');
    const sw2 = await m.evaluate(() => document.documentElement.scrollWidth); if (sw2 > 392) throw new Error('clients scrollWidth ' + sw2);
    await m.screenshot({ path: SHOTS + '/m-clients.png' });
    await m.click('[data-action=register-client]'); await m.waitForSelector('.modal'); await m.screenshot({ path: SHOTS + '/m-register.png' });
  });
  await step('Logout', async () => { await p.click('[data-action=logout]'); await p.waitForSelector('#login-screen:not([hidden])'); });

  // ---------------- ADMIN ----------------
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
  await prep(actx);
  const a = await actx.newPage(); a.setDefaultTimeout(8000); watch(a, 'admin');
  await step('Admin login screen shows Google button', async () => { await a.goto(BASE + '/index.html'); await a.waitForSelector('#gsi-button button'); await a.screenshot({ path: SHOTS + '/a-login.png' }); });
  const token = await (await fetch(BASE + '/__admin_token')).text();
  await a.evaluate(t => sessionStorage.setItem('glp_session_admin', t), token); await a.reload();
  for (const [view, sel] of [['dashboard', '#perf .kpis'], ['clients', '#client-table table'], ['refills', '.board'], ['payments', '#pay .kpis'], ['companies', 'table'], ['admins', 'table'], ['audit', '#audit-table table'], ['settings', '#settings-form']]) {
    await step('Admin view: ' + view, async () => {
      await a.goto(BASE + '/index.html#/' + view); await a.reload(); await a.waitForSelector(sel, { timeout: 8000 }); await a.waitForTimeout(700);
      await a.screenshot({ path: SHOTS + '/a-' + view + '.png', fullPage: true });
    });
  }
  await step('Admin sees all companies in client list + company filter', async () => {
    await a.goto(BASE + '/index.html#/clients'); await a.waitForSelector('#client-table table');
    const t = await a.textContent('#client-table'); if (!/Beta Pharmacy/.test(t) || !/Alpha Clinic/.test(t)) throw new Error('missing companies');
  });
  await step('Admin profile: full history, audit tab, confirm completion', async () => {
    await a.selectOption('[name=status]', ''); await a.check('[name=awaitingReview]'); await a.waitForTimeout(700);
    await a.click('#client-table tbody tr'); await a.waitForSelector('[data-p=complete]');
    await a.click('[data-tab=audit]'); await a.waitForTimeout(200);
    await a.screenshot({ path: SHOTS + '/a-profile-audit.png', fullPage: true });
    await a.click('[data-p=complete]'); await a.waitForSelector('.modal-backdrop:last-child [name=note]');
    await a.fill('.modal-backdrop:last-child [name=note]', 'Reviewed by Dr. Malik – journey complete');
    await a.click('.modal-backdrop:last-child [data-submit]'); await a.waitForTimeout(900);
    const st = await a.textContent('.profile-head'); if (!/Completed/.test(st)) throw new Error('not completed');
    await a.click('.modal-backdrop [data-close]');
  });
  await step('Upsell filters: presets + company', async () => {
    await a.goto(BASE + '/index.html#/payments'); await a.waitForSelector('#pay .kpis');
    await a.click('[data-preset=all]'); await a.waitForTimeout(600);
    const all = await a.textContent('#pay .kpi .value');
    await a.click('[data-preset=today]'); await a.waitForTimeout(600);
    const td = await a.textContent('#pay .kpi .value');
    if (all === td) throw new Error('presets did not change totals ' + all);
    await a.click('[data-preset=all]'); await a.waitForTimeout(500);
    await a.screenshot({ path: SHOTS + '/a-payments-all.png', fullPage: true });
  });
  await step('Create company + partner login from UI (temp password shown once)', async () => {
    await a.goto(BASE + '/index.html#/companies'); await a.waitForSelector('[data-add-company]');
    await a.click('[data-add-company]'); await a.fill('.modal [name=companyName]', 'Gamma Wellness'); await a.click('.modal [data-submit]');
    await a.waitForSelector('.modal [name=username]'); await a.fill('.modal [name=username]', 'gamma.one'); await a.fill('.modal [name=fullName]', 'Gamma One');
    await a.click('.modal [data-submit]'); await a.waitForSelector('.secret-box'); await a.screenshot({ path: SHOTS + '/a-temp-password.png' });
    await a.click('.modal-backdrop:last-child [data-close]');
  });
  await step('Export to XLSX downloads a file', async () => {
    await a.goto(BASE + '/index.html#/clients'); await a.waitForSelector('#client-table table');
    await a.click('[data-action=export]'); await a.waitForSelector('.modal [name=dataset]');
    const [dl] = await Promise.all([a.waitForEvent('download'), a.click('.modal [data-submit]')]);
    if (!/\.xlsx$/.test(dl.suggestedFilename())) throw new Error(dl.suggestedFilename());
  });
  await step('Admin mobile performance view', async () => {
    await a.setViewportSize({ width: 390, height: 844 });
    await a.goto(BASE + '/index.html#/dashboard'); await a.waitForSelector('#perf .kpis'); await a.waitForTimeout(600);
    const sw = await a.evaluate(() => document.documentElement.scrollWidth); if (sw > 392) throw new Error('scrollWidth ' + sw);
    await a.screenshot({ path: SHOTS + '/m-admin-dashboard.png', fullPage: true });
  });
  await browser.close();
  results.forEach(r => console.log(r[0] + '  ' + r[1] + (r[2] ? '\n      → ' + r[2] : '')));
  console.log('\nJS errors: ' + (errors.length ? '\n' + errors.join('\n') : 'none'));
  console.log((results.filter(r => r[0] === 'PASS').length) + '/' + results.length + ' passed');
})();
