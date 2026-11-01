// End-to-end backend tests against the Apps Script emulator.  Run: node tests/backend.test.js
const assert = require('assert');
const crypto = require('crypto');
const { createRuntime } = require('./gas-mock');

const results = [];
function test(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}
const rid = () => crypto.randomUUID();
const rt = createRuntime({ quiet: true });
const S = rt.sandbox;
const today = S.today_();
const ok = (r) => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data; };
const err = (r, code) => { assert.strictEqual(r.ok, false, 'expected failure, got ok'); if (code) assert.strictEqual(r.error.code, code, JSON.stringify(r.error)); return r.error; };

let admin, pA1, pA2, pB, coA, coB, client1, client2, clientB, tempA1;

test('Setup creates all 14 sheets with headers, settings, bootstrap admin, trigger', () => {
  const msg = S.initializeSystem();
  assert.ok(/Setup complete/.test(msg));
  Object.keys(S.SCHEMA).forEach(n => { assert.ok(rt.sheets[n], n); assert.strictEqual(JSON.stringify(rt.sheets[n].data[0]), JSON.stringify(S.SCHEMA[n])); });
  assert.strictEqual(Object.keys(S.SCHEMA).length, 14);
  assert.ok(rt.props.PASSWORD_PEPPER && rt.props.PASSWORD_PEPPER.length === 64);
  assert.strictEqual(rt.triggers.length, 1);
  S.initializeSystem(); // idempotent
  assert.strictEqual(rt.sheets.Admin_Users.getLastRow(), 2);
});

test('Admin Google login – authorised @justlife.com account', () => {
  const d = ok(rt.call('auth.adminGoogle', { idToken: 'good:boss@justlife.com' }));
  assert.ok(/^[a-f0-9]{64}$/.test(d.token)); admin = d.token;
  assert.strictEqual(d.user.type, 'admin');
});
test('Unauthorised email rejection (gmail, other justlife user, bad token)', () => {
  err(rt.call('auth.adminGoogle', { idToken: 'good:someone@gmail.com' }), 'FORBIDDEN');
  err(rt.call('auth.adminGoogle', { idToken: 'good:stranger@justlife.com' }), 'FORBIDDEN');
  err(rt.call('auth.adminGoogle', { idToken: 'forged' }), 'AUTH');
});
test('Admin APIs refuse missing / forged tokens', () => {
  err(rt.call('company.list', {}), 'AUTH');
  err(rt.call('company.list', {}, 'a'.repeat(64)), 'AUTH');
});
test('Admin can create + deactivate another admin; cannot deactivate self', () => {
  const a = ok(rt.call('admin.save', { email: 'ops@justlife.com', fullName: 'Ops', role: 'Admin' }, admin));
  err(rt.call('admin.save', { email: 'x@gmail.com', fullName: 'X' }, admin), 'VALIDATION');
  const t = ok(rt.call('auth.adminGoogle', { idToken: 'good:ops@justlife.com' })).token;
  ok(rt.call('admin.setStatus', { adminId: a.adminId, status: 'Inactive' }, admin));
  err(rt.call('company.list', {}, t), 'AUTH'); // existing session revoked immediately
  const me = ok(rt.call('auth.me', {}, admin)).user;
  err(rt.call('admin.setStatus', { adminId: me.id, status: 'Inactive' }, admin), 'VALIDATION');
});

test('Company management + multiple partner logins per company', () => {
  coA = ok(rt.call('company.save', { companyName: 'Alpha Clinic', contactEmail: 'a@alpha.ae' }, admin)).companyId;
  coB = ok(rt.call('company.save', { companyName: 'Beta Pharmacy' }, admin)).companyId;
  err(rt.call('company.save', { companyName: 'alpha clinic' }, admin), 'DUPLICATE');
  const u1 = ok(rt.call('partnerUser.save', { companyId: coA, username: 'alpha.one', fullName: 'Alpha One', email: 'one@alpha.ae' }, admin));
  const u2 = ok(rt.call('partnerUser.save', { companyId: coA, username: 'alpha.two', fullName: 'Alpha Two', password: 'Secondpass99' }, admin));
  ok(rt.call('partnerUser.save', { companyId: coB, username: 'beta.one', fullName: 'Beta One', password: 'Betapass123' }, admin));
  err(rt.call('partnerUser.save', { companyId: coB, username: 'alpha.one', fullName: 'Dup' }, admin), 'DUPLICATE');
  tempA1 = u1.temporaryPassword;
  assert.ok(tempA1.length >= 10);
  const hash = rt.sheets.Partner_Users.data.find(r => r[2] === 'alpha.one')[6];
  assert.ok(hash.startsWith('pbkdf2_sha256$400$') && !hash.includes(tempA1), 'password hashed, not plain');
});

test('Partner login + forced password change + rate limiting', () => {
  err(rt.call('auth.partnerLogin', { username: 'alpha.one', password: 'wrong-one-1' }), 'AUTH');
  const d = ok(rt.call('auth.partnerLogin', { username: 'ALPHA.ONE', password: tempA1 }));
  assert.strictEqual(d.user.mustChangePassword, true);
  err(rt.call('client.list', {}, d.token), 'PASSWORD_CHANGE_REQUIRED');
  err(rt.call('auth.changePassword', { currentPassword: tempA1, newPassword: 'short' }, d.token), 'VALIDATION');
  ok(rt.call('auth.changePassword', { currentPassword: tempA1, newPassword: 'NewAlphaPass1' }, d.token));
  pA1 = d.token;
  ok(rt.call('client.list', {}, pA1));
  pA2 = ok(rt.call('auth.partnerLogin', { username: 'alpha.two', password: 'Secondpass99' })).token;
  ok(rt.call('auth.changePassword', { currentPassword: 'Secondpass99', newPassword: 'Secondpass100' }, pA2));
  pB = ok(rt.call('auth.partnerLogin', { username: 'beta.one', password: 'Betapass123' })).token;
  ok(rt.call('auth.changePassword', { currentPassword: 'Betapass123', newPassword: 'Betapass1234' }, pB));
  for (let i = 0; i < 5; i++) rt.call('auth.partnerLogin', { username: 'beta.one', password: 'nope-nope-' + i });
  err(rt.call('auth.partnerLogin', { username: 'beta.one', password: 'Betapass1234' }), 'LOCKED');
  ok(rt.call('partnerUser.resetPassword', { userId: S.findOne_('Partner_Users', 'Username', 'beta.one').User_ID, password: 'Resetpass123' }, admin));
  rt.cache.forEach((v, k) => { if (k.startsWith('lf_')) rt.cache.delete(k); });
  S.resetMemo_();
  pB = ok(rt.call('auth.partnerLogin', { username: 'beta.one', password: 'Resetpass123' })).token;
  ok(rt.call('auth.changePassword', { currentPassword: 'Resetpass123', newPassword: 'Betapass5678' }, pB));
});

test('Partners are denied admin-only APIs', () => {
  ['company.list', 'reports.upsell', 'audit.list', 'client.update', 'journey.setStatus', 'export.dataset', 'settings.save'].forEach(a => err(rt.call(a, {}, pA1), 'FORBIDDEN'));
});

const reg = (over = {}) => Object.assign({
  fullName: 'Ahmed Ali', phone: '+971 50 123 4567', externalClientId: 'JL-1001', firstBookingRef: 'BK-1', journeyStartDate: today,
  heightCm: 175, weightKg: 98, medicationType: 'Injection', medicationName: 'Mounjaro (Tirzepatide)', prescribedDosage: '5 mg', startingDosage: '2.5 mg',
  quantity: '4 pens', doctorName: 'Dr. Sara', prescriptionNotes: 'Weekly, titrate after 4 weeks', partnerNotes: 'First consultation done',
  amountCollected: 1200, paymentStatus: 'Paid', paymentRef: 'POS-1'
}, over);

test('New client registration creates client, 6-month journey, schedule, payment, notes', () => {
  const k = rid();
  const d = ok(rt.call('client.register', reg(), pA1, k));
  client1 = d.clientId;
  assert.ok(d.transactionId);
  const again = ok(rt.call('client.register', reg(), pA1, k));
  assert.strictEqual(again.duplicate, true, 'duplicate submission returns the existing client');
  assert.strictEqual(S.rows_('Clients').length, 1);
  assert.strictEqual(S.rows_('Payment_Transactions').length, 1);
  const j = S.findOne_('Client_Journeys', 'Client_ID', client1);
  assert.strictEqual(j.Expected_End_Date, S.addMonths_(today, 6));
  const sch = S.findOne_('Refill_Schedule', 'Client_ID', client1);
  assert.strictEqual(sch.Current_Expected_Date, S.addDays_(today, 30));
  const c = S.findOne_('Clients', 'Client_ID', client1);
  assert.strictEqual(c.BMI, '32');
  assert.strictEqual(c.Registration_Date, today);
  const tx = S.rows_('Payment_Transactions')[0];
  assert.strictEqual(tx.Payment_Date, today); assert.strictEqual(tx.Created_By, S.findOne_('Partner_Users', 'Username', 'alpha.one').User_ID);
});
test('Registration validation: mandatory note, duplicates, bad values, formula injection neutralised', () => {
  err(rt.call('client.register', reg({ externalClientId: 'X1', partnerNotes: '' }), pA1, rid()), 'VALIDATION');
  err(rt.call('client.register', reg(), pA1, rid()), 'DUPLICATE');
  err(rt.call('client.register', reg({ externalClientId: 'X2', medicationType: 'Patch' }), pA1, rid()), 'VALIDATION');
  err(rt.call('client.register', reg({ externalClientId: 'X3', amountCollected: 100, paymentStatus: '' }), pA1, rid()), 'VALIDATION');
  err(rt.call('client.register', reg({ externalClientId: 'X4' }), pA1), 'VALIDATION'); // no request id
  const d = ok(rt.call('client.register', reg({ externalClientId: 'JL-1002', fullName: '=HYPERLINK("x")', medicationType: 'Pills', medicationName: 'Rybelsus (Oral Semaglutide)',
    journeyStartDate: S.addDays_(today, -75), amountCollected: 500, paymentStatus: 'Pending' }), pA2, rid()));
  client2 = d.clientId;
  assert.strictEqual(S.findOne_('Clients', 'Client_ID', client2).Full_Name, '=HYPERLINK("x")'); // stored as text (mock throws on formulas)
  clientB = ok(rt.call('client.register', reg({ externalClientId: 'B-1', fullName: 'Beta Client', amountCollected: 300 }), pB, rid())).clientId;
});

test('Data isolation: partner B cannot list, read, refill, reschedule or note company A clients', () => {
  const list = ok(rt.call('client.list', {}, pB)).clients;
  assert.deepStrictEqual(Array.from(list.map(c => c.clientId)), [clientB]);
  const listA = ok(rt.call('client.list', { companyId: coB }, pA1)).clients; // tries to spoof companyId
  assert.ok(listA.every(c => c.companyId === coA) && listA.length === 2);
  err(rt.call('client.get', { clientId: client1 }, pB), 'NOT_FOUND');
  err(rt.call('refill.register', { clientId: client1 }, pB, rid()), 'NOT_FOUND');
  err(rt.call('refill.reschedule', { clientId: client1 }, pB), 'NOT_FOUND');
  err(rt.call('notes.add', { clientId: client1, note: 'x' }, pB), 'NOT_FOUND');
  const sum = ok(rt.call('dashboard.summary', { companyId: coA }, pB));
  assert.strictEqual(sum.totalClients, 1);
  assert.strictEqual(ok(rt.call('refills.board', {}, pB)).buckets.thisWeek.length + ok(rt.call('refills.board', {}, pB)).buckets.later.length, 1);
});

test('Journey progress + overdue status calculation', () => {
  const v1 = ok(rt.call('client.get', { clientId: client1 }, pA1)).view.journey;
  assert.strictEqual(v1.status, 'Active'); assert.strictEqual(v1.currentMonth, 1); assert.strictEqual(v1.completedMonths, 0); assert.strictEqual(v1.percent, 0);
  assert.deepStrictEqual(Array.from(v1.segments), ['current', 'next', 'future', 'future', 'future', 'future']);
  const v2 = ok(rt.call('client.get', { clientId: client2 }, pA1)).view.journey;
  assert.strictEqual(v2.status, 'Overdue'); assert.strictEqual(v2.refillStatus, 'Overdue');
  assert.strictEqual(v2.currentMonth, 3); assert.strictEqual(v2.completedMonths, 1);
  assert.deepStrictEqual(Array.from(v2.segments.slice(0, 3)), ['done', 'missed', 'missed']);
  const fut = ok(rt.call('client.register', reg({ externalClientId: 'JL-FUT', journeyStartDate: S.addDays_(today, 10), amountCollected: 0 }), pA1, rid())).clientId;
  assert.strictEqual(ok(rt.call('client.get', { clientId: fut }, pA1)).view.journey.status, 'Not Started');
});

let refill1;
test('Delayed refill (overdue client), no-change medication, idempotent', () => {
  const k = rid();
  const p = { clientId: client2, refillDate: today, bookingRef: 'BK-2', noChange: true, quantity: '30 tabs', amountCollected: 450, paymentStatus: 'Paid', doctorName: 'Dr. Omar', doctorNotes: 'Tolerating well', partnerNotes: 'Client came late' };
  const d = ok(rt.call('refill.register', p, pA1, k));
  refill1 = d.refillId;
  assert.strictEqual(ok(rt.call('refill.register', p, pA1, k)).duplicate, true);
  const r = S.findOne_('Refill_Records', 'Refill_ID', refill1);
  assert.ok(r.Timing.startsWith('Late (45d)'), r.Timing);
  assert.strictEqual(r.Medication_Name, 'Rybelsus (Oral Semaglutide)'); assert.strictEqual(r.Medication_Changed, 'FALSE');
  assert.strictEqual(r.Next_Refill_Date, S.addDays_(today, 30));
  assert.strictEqual(S.rows_('Payment_Transactions').filter(t => t.Source_ID === refill1).length, 1);
  assert.strictEqual(ok(rt.call('client.get', { clientId: client2 }, pA1)).view.journey.status, 'Active');
  err(rt.call('refill.register', Object.assign({}, p, { partnerNotes: '' }), pA1, rid()), 'VALIDATION');
});
test('Early refill with medication + dosage change is recorded in history', () => {
  ok(rt.call('refill.reschedule', { clientId: client1, newDate: today, reasonCategory: 'Early refill needed', note: 'Travelling soon' }, pA1));
  const d = ok(rt.call('refill.register', { clientId: client1, refillDate: today, bookingRef: 'BK-3', medicationType: 'Injection', medicationName: 'Wegovy (Semaglutide)', dosage: '0.5 mg', quantity: '4 pens', amountCollected: 900, paymentStatus: 'Paid', partnerNotes: 'Switched medication', nextRefillDate: S.addDays_(today, 28) }, pA1, rid()));
  const r = S.findOne_('Refill_Records', 'Refill_ID', d.refillId);
  assert.ok(r.Timing.startsWith('Early (30d)'), r.Timing);
  assert.strictEqual(r.Medication_Changed, 'TRUE'); assert.strictEqual(r.Dosage_Changed, 'TRUE');
  const c = S.findOne_('Clients', 'Client_ID', client1);
  assert.strictEqual(c.Current_Medication_Name, 'Wegovy (Semaglutide)'); assert.strictEqual(c.Initial_Medication_Name, 'Mounjaro (Tirzepatide)');
  const prof = ok(rt.call('client.get', { clientId: client1 }, pA1));
  assert.ok(prof.timeline.some(e => e.type === 'note-medication_change'));
  assert.strictEqual(prof.reschedules.length, 1);
  assert.strictEqual(prof.schedules[0].Original_Expected_Date, S.addDays_(today, 30), 'original date preserved');
});
test('Reschedule keeps full history and never overwrites refill records', () => {
  const s0 = S.rows_('Refill_Records').length;
  ok(rt.call('refill.reschedule', { clientId: client1, newDate: S.addDays_(today, 35), reasonCategory: 'Client travelling', note: 'Abroad' }, pA2));
  ok(rt.call('refill.reschedule', { clientId: client1, newDate: S.addDays_(today, 40), reasonCategory: 'Client postponed', note: 'Busy' }, pA1));
  const h = S.findAll_('Reschedule_History', 'Client_ID', client1);
  assert.strictEqual(h.length, 3);
  const open = S.openSchedule_(client1);
  assert.strictEqual(open.Original_Expected_Date, S.addDays_(today, 28)); assert.strictEqual(open.Current_Expected_Date, S.addDays_(today, 40)); assert.strictEqual(open.Reschedule_Count, '2');
  assert.strictEqual(S.rows_('Refill_Records').length, s0);
  err(rt.call('refill.reschedule', { clientId: client1, newDate: S.addDays_(today, 41), reasonCategory: 'Admin schedule correction', note: 'x' }, pA1), 'FORBIDDEN');
  ok(rt.call('refill.reschedule', { clientId: client1, newDate: S.addDays_(today, 38), reasonCategory: 'Admin schedule correction', note: 'Correct' }, admin));
});
test('Medication update + doctor notes + partner notes', () => {
  ok(rt.call('client.updateMedication', { clientId: client1, medicationType: 'Injection', medicationName: 'Wegovy (Semaglutide)', dosage: '1 mg', note: 'Doctor increased dose' }, pA1));
  ok(rt.call('notes.addDoctor', { clientId: client1, doctorName: 'Dr. Sara', note: 'Increase to 1 mg' }, pA1));
  ok(rt.call('notes.add', { clientId: client1, note: 'Called client' }, pA1));
  ok(rt.call('notes.add', { clientId: client1, note: 'Internal: verify Rx', internal: true }, admin));
  const pv = ok(rt.call('client.get', { clientId: client1 }, pA1));
  assert.ok(!pv.notes.some(n => n.Visibility === 'Internal'), 'partners never see internal notes');
  assert.ok(!pv.audit, 'partners never see audit');
  const av = ok(rt.call('client.get', { clientId: client1 }, admin));
  assert.ok(av.notes.some(n => n.Visibility === 'Internal')); assert.ok(av.audit.length > 3);
  assert.strictEqual(av.doctorNotes.length, 2);
});

test('Admin editing with audit history (client, refill, payment date correction)', () => {
  ok(rt.call('client.update', { clientId: client1, phone: '+971 55 000 0000', reason: 'Client changed number' }, admin));
  err(rt.call('client.update', { clientId: client1, phone: '+971 55 000 0001' }, admin), 'VALIDATION');
  ok(rt.call('refill.update', { refillId: refill1, quantity: '28 tabs', amountCollected: 480, reason: 'Typo' }, admin));
  const tx = S.findOne_('Payment_Transactions', 'Source_ID', refill1);
  assert.strictEqual(tx.Amount, '480');
  ok(rt.call('payment.update', { transactionId: tx.Transaction_ID, paymentDate: S.addDays_(today, -1), reason: 'Collected yesterday' }, admin));
  assert.strictEqual(S.findOne_('Refill_Records', 'Refill_ID', refill1).Payment_Date, S.addDays_(today, -1));
  const logs = ok(rt.call('audit.list', { entityType: 'Payment' }, admin)).logs;
  const last = logs[0];
  assert.strictEqual(last.Action, 'PAYMENT_UPDATED'); assert.ok(last.Before_JSON.includes(today) && last.After_JSON.includes(S.addDays_(today, -1)));
  assert.ok(!JSON.stringify(ok(rt.call('audit.list', {}, admin)).logs).includes('pbkdf2_sha256'), 'no password hashes in audit');
});

test('Payment tracker: auto transactions, Paid-only revenue, presets & filters', () => {
  const all = ok(rt.call('reports.upsell', { preset: 'all' }, admin));
  // Paid: 1200 (reg c1) + 300 (B) + 900 (refill c1) + 480 (refill c2); pending 500 excluded
  assert.strictEqual(all.totals.amount, 2880); assert.strictEqual(all.totals.transactions, 4); assert.strictEqual(all.totals.pendingAmount, 500);
  assert.strictEqual(all.totals.upsell, 1380);
  const t = ok(rt.call('reports.upsell', { preset: 'today' }, admin));
  assert.strictEqual(t.totals.amount, 2400);
  const w = ok(rt.call('reports.upsell', { preset: 'this_week' }, admin));
  const lw = ok(rt.call('reports.upsell', { preset: 'last_week' }, admin));
  assert.strictEqual(w.totals.amount + lw.totals.amount <= 2880, true);
  const yesterdayInThisWeek = S.weekStart_(S.addDays_(today, -1)) === S.weekStart_(today);
  assert.strictEqual(w.totals.amount, yesterdayInThisWeek ? 2880 : 2400);
  const byB = ok(rt.call('reports.upsell', { preset: 'all', companyId: coB }, admin));
  assert.strictEqual(byB.totals.amount, 300);
  const pills = ok(rt.call('reports.upsell', { preset: 'all', medicationType: 'Pills' }, admin));
  assert.strictEqual(pills.totals.amount, 480);
  const custom = ok(rt.call('reports.upsell', { preset: 'custom', from: S.addDays_(today, -1), to: S.addDays_(today, -1) }, admin));
  assert.strictEqual(custom.totals.amount, 480);
  const userA2 = S.findOne_('Partner_Users', 'Username', 'alpha.two').User_ID;
  assert.strictEqual(ok(rt.call('reports.upsell', { preset: 'all', createdBy: userA2 }, admin)).totals.amount, 0);
  assert.ok(all.byCompany.find(c => c.companyId === coA).amount === 2580);
});

test('Performance report: partner-wise table, KPIs, configurable conversion', () => {
  const r = ok(rt.call('reports.performance', { from: S.addDays_(today, -90), to: today }, admin));
  const A = r.partners.find(p => p.companyId === coA), B = r.partners.find(p => p.companyId === coB);
  assert.strictEqual(A.newClients, 3); assert.strictEqual(B.newClients, 1);
  assert.strictEqual(A.refillsCompleted, 2); assert.strictEqual(A.revenue, 2580); assert.strictEqual(B.revenue, 300);
  assert.strictEqual(r.kpi.revenue, 2880);
  assert.strictEqual(A.conversionPct, 100); // ELIGIBLE denominator: c2 eligible+converted, c1 converted early
  ok(rt.call('settings.save', { settings: { CONVERSION_DENOMINATOR: 'REGISTERED' } }, admin));
  const r2 = ok(rt.call('reports.performance', { from: S.addDays_(today, -90), to: today }, admin));
  assert.strictEqual(r2.partners.find(p => p.companyId === coA).conversionPct, 66.7);
  assert.ok(r2.monthly.length >= 3);
});

test('Reminders: categories, no duplicates, emails optional, resolved after refill', () => {
  // client due within 3 days and one overdue
  const c3 = ok(rt.call('client.register', reg({ externalClientId: 'JL-R3', fullName: 'Due Soon', journeyStartDate: S.addDays_(today, -28), amountCollected: 0 }), pA1, rid())).clientId;
  const cOver = ok(rt.call('client.register', reg({ externalClientId: 'JL-OV', fullName: 'Overdue One', journeyStartDate: S.addDays_(today, -40), amountCollected: 0 }), pA1, rid())).clientId;
  ok(rt.call('settings.save', { settings: { REMINDER_EMAILS_ENABLED: 'TRUE' } }, admin));
  const r1 = ok(rt.call('reminders.run', {}, admin));
  assert.ok(r1.created >= 2);
  const r2 = ok(rt.call('reminders.run', {}, admin));
  assert.strictEqual(r2.created, 0, 'no duplicate reminders');
  const n = ok(rt.call('notifications.list', {}, pA1)).notifications;
  assert.ok(n.some(x => x.clientId === c3 && x.category === 'DUE_3_DAYS'));
  assert.ok(n.some(x => x.clientId === cOver && x.category === 'OVERDUE'));
  assert.ok(ok(rt.call('notifications.list', {}, pB)).notifications.every(x => x.companyName === 'Beta Pharmacy'));
  assert.strictEqual(rt.mails.length, 1, 'one digest email to the company user with an email');
  ok(rt.call('refill.register', { clientId: cOver, refillDate: today, bookingRef: 'BK-OV', noChange: true, quantity: '4', partnerNotes: 'Done' }, pA1, rid()));
  assert.ok(!ok(rt.call('notifications.list', {}, pA1)).notifications.some(x => x.clientId === cOver));
  ok(rt.call('notifications.markRead', { all: true }, pA1));
  assert.strictEqual(ok(rt.call('dashboard.summary', {}, pA1)).unreadNotifications, 0);
  ok(rt.call('settings.save', { settings: { REMINDER_EMAILS_ENABLED: 'FALSE' } }, admin));
});

test('Stop, reactivate, pause journeys; refills blocked while stopped/paused', () => {
  ok(rt.call('journey.setStatus', { clientId: client2, status: 'Stopped', reason: 'Side effects' }, admin));
  assert.strictEqual(ok(rt.call('client.get', { clientId: client2 }, pA1)).view.journey.status, 'Stopped');
  err(rt.call('refill.register', { clientId: client2, refillDate: today, bookingRef: 'x', noChange: true, quantity: '1', partnerNotes: 'x' }, pA1, rid()), 'VALIDATION');
  err(rt.call('journey.setStatus', { clientId: client2, status: 'Active', reason: 'Back' }, admin), 'VALIDATION'); // needs next date
  ok(rt.call('journey.setStatus', { clientId: client2, status: 'Active', reason: 'Back', nextRefillDate: S.addDays_(today, 3) }, admin));
  const open = S.openSchedule_(client2);
  assert.strictEqual(open.Cycle_Number, '2'); assert.strictEqual(open.Current_Expected_Date, S.addDays_(today, 3));
  ok(rt.call('journey.setStatus', { clientId: client2, status: 'Paused', reason: 'Travelling 2 months' }, admin));
  assert.strictEqual(ok(rt.call('client.get', { clientId: client2 }, pA1)).view.journey.status, 'Paused');
  ok(rt.call('journey.setStatus', { clientId: client2, status: 'Active', reason: 'Returned', nextRefillDate: S.addDays_(today, 5) }, admin));
  assert.strictEqual(S.openSchedule_(client2).Current_Expected_Date, S.addDays_(today, 5));
});

test('Full 6-month journey → awaiting review → admin confirms completion (not automatic)', () => {
  const c = ok(rt.call('client.register', reg({ externalClientId: 'JL-FULL', fullName: 'Full Journey', journeyStartDate: S.addDays_(today, -200), amountCollected: 0 }), pA1, rid())).clientId;
  for (let i = 1; i <= 5; i++) {
    const d = ok(rt.call('refill.register', { clientId: c, refillDate: S.addDays_(today, -200 + 30 * i), bookingRef: 'BK-F' + i, noChange: true, quantity: '4', amountCollected: 100, paymentStatus: 'Paid', partnerNotes: 'Refill ' + i, nextRefillDate: S.addDays_(today, -200 + 30 * (i + 1)) }, pA1, rid()));
    assert.strictEqual(d.isLastRefill, i === 5);
  }
  let v = ok(rt.call('client.get', { clientId: c }, pA1)).view.journey;
  assert.strictEqual(v.milestones, 6); assert.strictEqual(v.awaitingReview, true); assert.strictEqual(v.status, 'Active'); assert.strictEqual(v.percent, 100);
  err(rt.call('refill.register', { clientId: c, refillDate: today, bookingRef: 'x', noChange: true, quantity: '1', partnerNotes: 'x' }, pA1, rid()), 'VALIDATION');
  err(rt.call('journey.confirmCompletion', { clientId: client1, note: 'x' }, admin), 'VALIDATION'); // only 2/6 months
  ok(rt.call('journey.confirmCompletion', { clientId: c, note: 'Reviewed by Dr. Sara' }, admin));
  v = ok(rt.call('client.get', { clientId: c }, pA1)).view.journey;
  assert.strictEqual(v.status, 'Completed'); assert.ok(v.segments.every(s => s === 'done'));
});

test('Export datasets for admin only, without secrets', () => {
  const d = ok(rt.call('export.dataset', { dataset: 'clients' }, admin));
  assert.ok(d.rows.length >= 6 && d.rows[0].Journey_Status);
  assert.ok(!JSON.stringify(d.rows).includes('Idempotency_Key'));
  ok(rt.call('export.dataset', { dataset: 'payments' }, admin));
});

test('Company deactivation blocks partner sessions immediately', () => {
  ok(rt.call('company.setStatus', { companyId: coB, status: 'Inactive' }, admin));
  err(rt.call('client.list', {}, pB), 'AUTH');
  err(rt.call('auth.partnerLogin', { username: 'beta.one', password: 'Betapass5678' }), 'AUTH');
  ok(rt.call('company.setStatus', { companyId: coB, status: 'Active' }, admin));
});

test('Logout invalidates the session', () => {
  const t = ok(rt.call('auth.partnerLogin', { username: 'alpha.two', password: 'Secondpass100' })).token;
  ok(rt.call('auth.logout', {}, t));
  err(rt.call('auth.me', {}, t), 'AUTH');
});

test('Every route is reachable and role-guarded', () => {
  Object.keys(S.ROUTES).forEach(a => {
    const r = S.ROUTES[a];
    if (r.roles.indexOf('public') >= 0) return;
    const resp = rt.call(a, {}, undefined);
    assert.strictEqual(resp.error.code, 'AUTH', a);
  });
});

const fails = results.filter(r => r[0] === 'FAIL');
results.forEach(r => console.log(r[0] + '  ' + r[1] + (r[2] ? '\n      → ' + r[2] : '')));
console.log('\n' + (results.length - fails.length) + '/' + results.length + ' passed');
process.exit(fails.length ? 1 : 0);
