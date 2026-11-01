// Local test server: static frontend + emulated Apps Script backend on /api, seeded with demo data.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRuntime } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const rt = createRuntime({ quiet: true });
const S = rt.sandbox;
S.initializeSystem();
const ok = r => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data; };
const rid = () => crypto.randomUUID();
const today = S.today_();
const admin = ok(rt.call('auth.adminGoogle', { idToken: 'good:boss@justlife.com' })).token;
const coA = ok(rt.call('company.save', { companyName: 'Alpha Clinic', contactName: 'Mona', contactEmail: 'ops@alpha.ae', contactPhone: '+971 4 111 2222' }, admin)).companyId;
const coB = ok(rt.call('company.save', { companyName: 'Beta Pharmacy' }, admin)).companyId;
ok(rt.call('partnerUser.save', { companyId: coA, username: 'alpha.one', fullName: 'Alpha One', email: 'one@alpha.ae', password: 'TempPass123' }, admin));
ok(rt.call('partnerUser.save', { companyId: coB, username: 'beta.one', fullName: 'Beta One', password: 'BetaPass123' }, admin));
// a ready partner user for seeding (password already changed)
ok(rt.call('partnerUser.save', { companyId: coA, username: 'alpha.seed', fullName: 'Alpha Seeder', password: 'SeedPass123' }, admin));
let seed = ok(rt.call('auth.partnerLogin', { username: 'alpha.seed', password: 'SeedPass123' })).token;
ok(rt.call('auth.changePassword', { currentPassword: 'SeedPass123', newPassword: 'SeedPass1234' }, seed));
let bseed = ok(rt.call('auth.partnerLogin', { username: 'beta.one', password: 'BetaPass123' })).token;
ok(rt.call('auth.changePassword', { currentPassword: 'BetaPass123', newPassword: 'BetaPass1234' }, bseed));

const meds = ['Mounjaro (Tirzepatide)', 'Ozempic (Semaglutide)', 'Wegovy (Semaglutide)', 'Rybelsus (Oral Semaglutide)', 'Saxenda (Liraglutide)'];
const names = ['Ahmed Al Mansoori', 'Fatima Khan', 'John Peters', 'Layla Haddad', 'Omar Siddiqui', 'Priya Nair', 'Sara Lopez', 'Yousef Rahman', 'Maria Rossi', 'Daniel Kim'];
const clients = [];
names.forEach((n, i) => {
  const tok = i < 7 ? seed : bseed;
  const start = S.addDays_(today, -[5, 33, 40, 62, 95, 120, 185, 15, 70, 2][i]);
  const med = meds[i % meds.length];
  const id = ok(rt.call('client.register', { fullName: n, phone: '+971 50 ' + (1000000 + i * 1371), externalClientId: 'JL-' + (2001 + i), firstBookingRef: 'BK-' + (9100 + i), journeyStartDate: start,
    heightCm: 160 + i * 2, weightKg: 85 + i * 3, medicationType: med.indexOf('Rybelsus') >= 0 ? 'Pills' : 'Injection', medicationName: med, prescribedDosage: '5 mg', startingDosage: '2.5 mg', quantity: '4 pens',
    doctorName: 'Dr. Sara Malik', prescriptionNotes: 'Titrate monthly as tolerated', partnerNotes: 'Initial consultation completed', amountCollected: 900 + i * 50, paymentStatus: i === 3 ? 'Pending' : 'Paid', paymentRef: 'POS-' + i }, tok, rid())).clientId;
  clients.push({ id, start, tok, i });
});
// refills to create history
const refill = (c, n, opts = {}) => { for (let k = 1; k <= n; k++) ok(rt.call('refill.register', Object.assign({ clientId: c.id, refillDate: S.addDays_(c.start, 30 * k + (k % 2 ? 2 : -1)), bookingRef: 'BK-R' + c.i + k, noChange: true, quantity: '4 pens', amountCollected: 750, paymentStatus: 'Paid', partnerNotes: 'Refill ' + k + ' delivered', doctorNotes: k === 2 ? 'Good progress, -6kg' : '', nextRefillDate: S.addDays_(c.start, 30 * (k + 1)) }, opts), c.tok, rid())); };
refill(clients[2], 1); refill(clients[3], 1); refill(clients[4], 3); refill(clients[5], 3); refill(clients[6], 5); refill(clients[8], 2);
ok(rt.call('refill.reschedule', { clientId: clients[1].id, newDate: S.addDays_(today, 2), reasonCategory: 'Client travelling', note: 'Back on Thursday' }, seed));
ok(rt.call('journey.setStatus', { clientId: clients[9].id, status: 'Stopped', reason: 'Client discontinued – side effects' }, admin));
ok(rt.call('client.updateMedication', { clientId: clients[4].id, medicationType: 'Injection', medicationName: 'Mounjaro (Tirzepatide)', dosage: '7.5 mg', note: 'Dose increased by doctor' }, seed));
ok(rt.call('reminders.run', {}, admin));
// back-date some payments (admin correction) so date filters have spread
S.rows_('Payment_Transactions').slice(0, 6).forEach((x, i) => ok(rt.call('payment.update', { transactionId: x.Transaction_ID, paymentDate: S.addDays_(today, -[3, 9, 16, 35, 48, 70][i]), reason: 'Seed: actual collection date' }, admin)));

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.env.PORT || 8787);
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      S.resetMemo_();
      const out = S.doPost({ postData: { contents: body } }).getContent();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(out);
    });
    return;
  }
  if (req.url === '/__admin_token') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ok(rt.call('auth.adminGoogle', { idToken: 'good:boss@justlife.com' })).token); }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end("window.APP_CONFIG={API_URL:'http://localhost:" + port + "/api',GOOGLE_CLIENT_ID:'test-client-id.apps.googleusercontent.com',APP_NAME:'GLP-1 Care CRM',REQUEST_TIMEOUT_MS:20000};");
  }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log('test server on ' + port));
