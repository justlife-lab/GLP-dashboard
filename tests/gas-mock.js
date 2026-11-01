// Minimal Google Apps Script runtime emulation for local testing of code.js.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const path = require('path');

function signed(buf) { return Array.from(buf).map(b => (b > 127 ? b - 256 : b)); }
function unsigned(arr) { return Buffer.from(arr.map(b => b & 0xff)); }

function makeSheet(name) {
  const data = []; // array of row arrays
  const sheet = {
    name, data, maxRows: 1000, maxCols: 26, frozen: 0, validations: [],
    getName: () => name,
    getLastRow: () => { for (let i = data.length - 1; i >= 0; i--) if (data[i] && data[i].some(v => v !== '' && v != null)) return i + 1; return 0; },
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r ? r.length : 0), 0),
    getMaxRows: () => sheet.maxRows, getMaxColumns: () => sheet.maxCols,
    insertColumnsAfter: (a, n) => { sheet.maxCols += n; },
    setFrozenRows: n => { sheet.frozen = n; },
    getRange: (r, c, nr = 1, nc = 1) => makeRange(sheet, r, c, nr, nc)
  };
  return sheet;
}
function makeRange(sheet, r, c, nr, nc) {
  const rng = {
    getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (sheet.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
    setValues: vals => {
      if (vals.length !== nr || vals[0].length !== nc) throw new Error('Range dimension mismatch');
      for (let i = 0; i < nr; i++) { const ri = r - 1 + i; sheet.data[ri] = sheet.data[ri] || []; for (let j = 0; j < nc; j++) { let v = vals[i][j]; if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1); else if (typeof v === 'string' && v.startsWith('=')) throw new Error('FORMULA WRITTEN: ' + v); sheet.data[ri][c - 1 + j] = v; } }
      if (r - 1 + nr > sheet.maxRows) sheet.maxRows = r - 1 + nr;
      return rng;
    },
    setNumberFormat: () => rng, setFontWeight: () => rng, setBackground: () => rng, setFontColor: () => rng,
    setDataValidation: v => { sheet.validations.push(v); return rng; }
  };
  return rng;
}

function createRuntime(opts = {}) {
  const sheets = {};
  const props = Object.assign({ GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com', BOOTSTRAP_ADMIN_EMAIL: 'boss@justlife.com', PBKDF2_ITERATIONS: '400' }, opts.props || {});
  const cache = new Map();
  const mails = [];
  const triggers = [];
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: s => { delete sheets[s.name]; }
  };
  sheets.Sheet1 = makeSheet('Sheet1');
  const fmt = (date, tz, f) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz === 'UTC' ? 'UTC' : tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const g = t => parts.find(p => p.type === t).value;
    return f.replace('yyyy', g('year')).replace('yy', g('year').slice(2)).replace('MM', g('month')).replace('dd', g('day'));
  };
  const sandbox = {
    console: opts.quiet ? { log() {}, error() {} } : console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss, flush: () => {},
      newDataValidation: () => { const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) }; return b; }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache.get(k); if (!e) return null; if (e.exp < Date.now()) { cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => { cache.set(k, { v, exp: Date.now() + (ttl || 600) * 1000 }); },
      remove: k => cache.delete(k)
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: fmt,
      DigestAlgorithm: { SHA_256: 'sha256' }, MacAlgorithm: { HMAC_SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, val) => signed(crypto.createHash('sha256').update(typeof val === 'string' ? Buffer.from(val, 'utf8') : unsigned(val)).digest()),
      computeHmacSignature: (alg, val, key) => signed(crypto.createHmac('sha256', unsigned(key)).update(unsigned(val)).digest()),
      base64Encode: b => unsigned(b).toString('base64'),
      base64Decode: s => signed(Buffer.from(s, 'base64')),
      newBlob: s => ({ getBytes: () => signed(Buffer.from(String(s), 'utf8')) })
    },
    Session: { getScriptTimeZone: () => 'Asia/Dubai' },
    UrlFetchApp: { fetch: url => {
      const tok = decodeURIComponent(url.split('id_token=')[1]);
      const m = /^good:(.+)$/.exec(tok);
      if (!m) return { getResponseCode: () => 400, getContentText: () => '{"error":"invalid_token"}' };
      const email = m[1], dom = email.split('@')[1];
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ aud: props.GOOGLE_CLIENT_ID, iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 3600), email, email_verified: 'true', hd: dom === 'gmail.com' ? undefined : dom, name: 'Test ' + email.split('@')[0] }) };
    } },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: o => mails.push(o) },
    ScriptApp: { getProjectTriggers: () => triggers, deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: h => { const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, inTimezone: () => b, create: () => { triggers.push({ getHandlerFunction: () => h }); } }; return b; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; }, getContent() { return s; } }) }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'code.js'), 'utf8'), sandbox, { filename: 'code.js' });
  return { sandbox, sheets, props, cache, mails, triggers,
    call: (action, payload, token, requestId) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify({ action, payload, token, requestId }) } }).getContent()) };
}
module.exports = { createRuntime };
