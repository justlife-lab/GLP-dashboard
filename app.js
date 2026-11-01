/* =============================================================================
 * Justlife GLP-1 Care CRM – shared frontend for index.html (Admin) and
 * partner.html (Partner). The portal is chosen by <body data-portal="...">, but
 * every permission is enforced by the Apps Script backend: the frontend only
 * decides which screens to draw, never what data a user may see or change.
 * ========================================================================== */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var PORTAL = document.body.getAttribute('data-portal') === 'admin' ? 'admin' : 'partner';
  var TOKEN_KEY = 'glp_session_' + PORTAL;
  var state = { token: null, user: null, meta: null, view: null, params: {}, charts: [], refresh: null, expiryTimer: null, busy: 0 };

  /* ===========================================================================
   * 1. UTILITIES
   * ========================================================================= */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  /** Escape every value placed into HTML (XSS protection). */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"'`=\/]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;' }[c];
    });
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function debounce(fn, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(s) {
    if (!s) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return esc(s);
    return m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1];
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function currency() { return (state.meta && state.meta.currency) || 'AED'; }
  function money(n, cur) {
    var v = Number(n || 0);
    return (cur || currency()) + ' ' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function pct(n) { return n === null || n === undefined ? '—' : n + '%'; }
  function todayStr() { return (state.meta && state.meta.today) || new Date().toISOString().slice(0, 10); }
  function addDays(s, n) { var d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p.charAt(0).toUpperCase(); }).join('') || '?'; }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function opts(list, selected, placeholder) {
    var h = placeholder !== undefined ? '<option value="">' + esc(placeholder) + '</option>' : '';
    (list || []).forEach(function (o) {
      var v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : o;
      h += '<option value="' + esc(v) + '"' + (String(v) === String(selected === undefined ? '' : selected) ? ' selected' : '') + '>' + esc(l) + '</option>';
    });
    return h;
  }
  function isAdmin() { return PORTAL === 'admin'; }

  /* ===========================================================================
   * 2. API CLIENT  (text/plain POST = CORS "simple request", no preflight)
   * ========================================================================= */
  function ApiError(code, message) { this.code = code; this.message = message; }
  ApiError.prototype = Object.create(Error.prototype);

  function loader(on) {
    var el = $('#top-loader');
    state.busy += on ? 1 : -1;
    if (state.busy > 0) { el.classList.remove('done'); el.classList.add('active'); }
    else { state.busy = 0; el.classList.remove('active'); el.classList.add('done'); }
  }

  function api(action, payload, options) {
    options = options || {};
    if (!CFG.API_URL || CFG.API_URL.indexOf('PASTE_') >= 0) return Promise.reject(new ApiError('CONFIG', 'API_URL is not configured in config.js'));
    var body = JSON.stringify({ action: action, payload: payload || {}, token: state.token || undefined, requestId: options.requestId });
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, CFG.REQUEST_TIMEOUT_MS || 45000);
    loader(true);
    return fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
      .catch(function (e) { throw new ApiError('NETWORK', e && e.name === 'AbortError' ? 'The server took too long to respond. Please try again.' : 'Cannot reach the server. Check your connection and try again.'); })
      .then(function (res) { return res.json().catch(function () { throw new ApiError('BAD_RESPONSE', 'Unexpected response from the server.'); }); })
      .then(function (json) {
        if (json && json.ok) return json.data;
        var e = (json && json.error) || { code: 'SERVER_ERROR', message: 'Unknown error' };
        if (e.code === 'AUTH' && state.token && !options.silentAuth) sessionExpired(e.message);
        if (e.code === 'PASSWORD_CHANGE_REQUIRED') changePasswordModal(true);
        throw new ApiError(e.code, e.message);
      })
      .finally(function () { clearTimeout(timer); loader(false); });
  }

  /* ===========================================================================
   * 3. UI PRIMITIVES: toast, modal, confirm, forms
   * ========================================================================= */
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = msg;
    $('#toast-root').appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, type === 'error' ? 6000 : 3500);
    setTimeout(function () { el.remove(); }, type === 'error' ? 6400 : 3900);
  }

  var modalStack = [];
  function modal(o) {
    var wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.style.zIndex = String(100 + modalStack.length * 10);
    wrap.innerHTML = '<div class="modal ' + esc(o.size || '') + '" role="dialog" aria-modal="true" aria-labelledby="mh-' + modalStack.length + '">' +
      '<div class="modal-head"><div class="grow"><h2 id="mh-' + modalStack.length + '">' + esc(o.title) + '</h2>' + (o.subtitle ? '<div class="muted small">' + o.subtitle + '</div>' : '') + '</div>' +
      '<button class="icon-btn" data-close aria-label="Close">✕</button></div>' +
      '<div class="modal-body">' + (o.body || '') + '</div>' + (o.footer ? '<div class="modal-foot">' + o.footer + '</div>' : '') + '</div>';
    document.getElementById('modal-root').appendChild(wrap);
    document.body.style.overflow = 'hidden';
    var handle = {
      el: wrap.querySelector('.modal'), wrap: wrap,
      close: function () {
        if (handle.closed) return; handle.closed = true;
        wrap.remove();
        modalStack.splice(modalStack.indexOf(handle), 1);
        if (!modalStack.length) document.body.style.overflow = '';
        if (o.onClose) o.onClose();
      },
      body: function (html) { wrap.querySelector('.modal-body').innerHTML = html; }
    };
    modalStack.push(handle);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap && !o.persistent) handle.close(); });
    $$('[data-close]', wrap).forEach(function (b) { b.addEventListener('click', handle.close); });
    if (o.onMount) o.onMount(handle);
    var first = wrap.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first && !o.noAutofocus) setTimeout(function () { first.focus(); }, 30);
    return handle;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modalStack.length && !modalStack[modalStack.length - 1].persistent) modalStack[modalStack.length - 1].close();
  });

  function confirmBox(o) {
    return new Promise(function (resolve) {
      var done = false;
      var m = modal({
        title: o.title, size: 'sm',
        body: '<p>' + esc(o.message) + '</p>' + (o.reason ? field({ name: 'reason', label: o.reasonLabel || 'Reason', type: 'textarea', required: true }) : ''),
        footer: '<button class="btn" data-close>Cancel</button><button class="btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + '" data-ok>' + esc(o.confirmLabel || 'Confirm') + '</button>',
        onClose: function () { if (!done) resolve(false); }
      });
      $('[data-ok]', m.el).addEventListener('click', function () {
        var r = true;
        if (o.reason) { r = $('[name=reason]', m.el).value.trim(); if (!r) { toast('Please enter a reason', 'error'); return; } }
        done = true; m.close(); resolve(r);
      });
    });
  }

  /** Field renderer. spec: {name,label,type,required,options,value,hint,full,readonly,min,max,step,placeholder,attrs} */
  function field(f) {
    var id = 'f-' + f.name + '-' + Math.random().toString(36).slice(2, 7);
    var req = f.required ? ' required' : '';
    var ro = f.readonly ? ' readonly' : '';
    var dis = f.disabled ? ' disabled' : '';
    var extra = (f.min !== undefined ? ' min="' + esc(f.min) + '"' : '') + (f.max !== undefined ? ' max="' + esc(f.max) + '"' : '') + (f.step !== undefined ? ' step="' + esc(f.step) + '"' : '') +
      (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + (f.attrs || '');
    var v = f.value === undefined || f.value === null ? '' : f.value;
    var input;
    if (f.type === 'select') input = '<select id="' + id + '" name="' + esc(f.name) + '"' + req + dis + extra + '>' + opts(f.options, v, f.placeholder === undefined ? (f.required ? 'Select…' : '—') : f.placeholder) + '</select>';
    else if (f.type === 'textarea') input = '<textarea id="' + id + '" name="' + esc(f.name) + '"' + req + ro + dis + extra + ' maxlength="' + (f.maxlength || 3000) + '">' + esc(v) + '</textarea>';
    else if (f.type === 'checkbox') return '<label class="check ' + (f.full ? 'full' : '') + '"><input type="checkbox" name="' + esc(f.name) + '"' + (v ? ' checked' : '') + dis + extra + '> ' + esc(f.label) + '</label>';
    else input = '<input id="' + id + '" type="' + (f.type || 'text') + '" name="' + esc(f.name) + '" value="' + esc(v) + '"' + req + ro + dis + extra + '>';
    return '<label class="field ' + (f.full ? 'full' : '') + '" for="' + id + '"><span>' + esc(f.label) + (f.required ? ' <b class="req">*</b>' : '') + '</span>' + input + (f.hint ? '<small class="hint">' + esc(f.hint) + '</small>' : '') + '</label>';
  }
  function section(title, fields) { return '<div class="form-section"><h3>' + esc(title) + '</h3><div class="form-grid">' + fields.map(field).join('') + '</div></div>'; }
  function readForm(form) {
    var o = {};
    $$('input, select, textarea', form).forEach(function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else o[el.name] = el.value.trim();
    });
    return o;
  }

  /** Modal containing a form. One requestId per opened form = idempotent submit. */
  function formModal(o) {
    var requestId = uuid();
    var m = modal({
      title: o.title, subtitle: o.subtitle, size: o.size || 'lg', persistent: true,
      body: '<form class="form" novalidate>' + o.body + '<div class="alert alert-error" data-form-error hidden></div></form>',
      footer: '<button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" data-submit>' + esc(o.submitLabel || 'Save') + '</button>',
      onMount: function (h) { if (o.onMount) o.onMount(h, $('form', h.el)); }
    });
    var form = $('form', m.el), btn = $('[data-submit]', m.el), errBox = $('[data-form-error]', m.el), busy = false;
    function submit() {
      if (busy) return;
      errBox.hidden = true;
      var bad = $$('[required]', form).filter(function (el) { return !el.disabled && (el.type === 'checkbox' ? !el.checked : !el.value.trim()); });
      if (bad.length) {
        var lbl = bad[0].closest('.field'); errBox.textContent = 'Please complete: ' + bad.map(function (b) { var l = b.closest('.field'); return l ? l.querySelector('span').textContent.replace('*', '').trim() : b.name; }).join(', ');
        errBox.hidden = false; bad[0].focus(); if (lbl) lbl.scrollIntoView({ block: 'center', behavior: 'smooth' }); return;
      }
      busy = true; btn.disabled = true; var label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> Saving…';
      Promise.resolve().then(function () { return o.onSubmit(readForm(form), requestId, m); })
        .then(function (res) { if (res !== false) m.close(); })
        .catch(function (e) { errBox.textContent = e.message || String(e); errBox.hidden = false; errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); })
        .finally(function () { busy = false; btn.disabled = false; btn.innerHTML = label; });
    }
    btn.addEventListener('click', submit);
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    return m;
  }

  /* ===========================================================================
   * 4. SHARED COMPONENTS
   * ========================================================================= */
  function badge(text, cls) { return '<span class="badge b-' + esc(cls || slug(text)) + '">' + esc(text) + '</span>'; }
  function statusBadge(j) {
    var h = badge(j.status);
    if (j.awaitingReview) h += ' ' + badge('Review', 'review');
    return h;
  }
  var REFILL_CLS = { 'Overdue': 'overdue', 'Due Today': 'due-today', 'Upcoming': 'upcoming', 'Completed': 'completed', 'All Refills Done': 'completed', 'Stopped': 'stopped', 'Paused': 'paused', 'None': 'none', 'Cancelled': 'cancelled' };
  function refillChip(j) {
    if (!j.nextRefillDate) return badge(j.refillStatus === 'None' ? '—' : j.refillStatus, REFILL_CLS[j.refillStatus] || 'grey');
    var d = j.daysToRefill, txt = d === 0 ? 'Today' : (d < 0 ? Math.abs(d) + 'd overdue' : 'in ' + d + 'd');
    if (j.status === 'Paused') txt = 'paused';
    return '<div class="nowrap">' + fmtDate(j.nextRefillDate) + '</div>' + badge(txt + (j.rescheduled ? ' · resched.' : ''), REFILL_CLS[j.refillStatus] || 'upcoming');
  }
  var SEG_LABEL = { done: 'Completed', current: 'Current month (supplied)', supplied: 'Supplied in advance', next: 'Next refill', due: 'Refill due', missed: 'Overdue – not supplied', stopped: 'Stopped', paused: 'Paused', future: 'Upcoming' };
  function journeyBar(j, large) {
    var segs = j.segments.map(function (s, i) { return '<span class="seg seg-' + esc(s) + '" title="Month ' + (i + 1) + ': ' + esc(SEG_LABEL[s] || s) + '"></span>'; }).join('');
    var meta = j.status === 'Not Started' ? 'Starts ' + fmtDate(j.startDate) : 'Month <strong>' + j.currentMonth + '</strong>/' + j.months;
    var html = '<div class="journey ' + (large ? 'journey-lg' : '') + '" role="img" aria-label="Journey ' + j.percent + '% complete, ' + esc(j.status) + '">' +
      '<div class="journey-segs" style="--n:' + j.months + '">' + segs + '</div>' +
      '<div class="journey-meta"><span>' + meta + '</span><span><strong>' + j.percent + '%</strong></span></div>';
    if (large) {
      html += '<div class="journey-steps" style="--n:' + j.months + '">' + j.segments.map(function (s, i) { return '<div><b>Month ' + (i + 1) + '</b>' + esc(SEG_LABEL[s] || s) + '</div>'; }).join('') + '</div>';
    }
    return html + '</div>';
  }
  function journeyLegend() {
    return '<div class="legend"><span><i class="seg-done"></i>Completed</span><span><i class="seg-current"></i>Current</span><span><i class="seg-supplied"></i>Supplied early</span><span><i class="seg-next"></i>Next / due</span><span><i class="seg-missed"></i>Overdue</span><span><i class="seg-paused"></i>Paused</span><span><i class="seg-stopped"></i>Stopped</span><span><i class="seg-future"></i>Upcoming</span></div>';
  }
  function kpi(label, value, cls, hint, action) {
    return '<div class="kpi ' + (cls || '') + (action ? ' clickable" data-action="' + esc(action) + '"' : '"') + '><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div>' + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  }
  function emptyState(msg, icon) { return '<div class="empty"><div class="big">' + (icon || '🗂️') + '</div>' + esc(msg) + '</div>'; }
  function skeleton(n) { var h = '<div class="page-loading">'; for (var i = 0; i < (n || 4); i++) h += '<div class="skeleton"></div>'; return h + '</div>'; }
  function errorBlock(e) { return '<div class="alert alert-error">' + esc(e.message || e) + ' <button class="btn btn-sm" data-action="reload-view">Retry</button></div>'; }

  /* ---------- charts ---------- */
  var PALETTE = ['#0B2545', '#2563EB', '#8DB8F2', '#059669', '#D97706', '#7C3AED', '#DC2626', '#0891B2', '#64748B', '#DB2777'];
  function destroyCharts() { state.charts.forEach(function (c) { try { c.destroy(); } catch (e) {} }); state.charts = []; }
  function chartBox(id, title, sub) { return '<div class="card"><div class="card-head"><h2>' + esc(title) + '</h2>' + (sub ? '<span class="muted small">' + esc(sub) + '</span>' : '') + '</div><div class="card-body"><div class="chart-box"><canvas id="' + id + '"></canvas></div></div></div>'; }
  function makeChart(id, type, labels, datasets, o) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!window.Chart) { el.parentNode.innerHTML = '<div class="chart-fallback">Charts unavailable (Chart.js failed to load)</div>'; return; }
    o = o || {};
    if (!labels.length) { el.parentNode.innerHTML = '<div class="chart-fallback">No data for the selected filters</div>'; return; }
    datasets.forEach(function (d, i) {
      var c = d.color || PALETTE[i % PALETTE.length];
      d.backgroundColor = d.backgroundColor || (type === 'line' ? c + '22' : c);
      d.borderColor = c; d.borderWidth = type === 'line' ? 2.5 : 0; d.borderRadius = type === 'bar' ? 6 : 0;
      if (type === 'line') { d.tension = .3; d.fill = d.fill !== undefined ? d.fill : true; d.pointRadius = labels.length > 40 ? 0 : 3; }
      d.maxBarThickness = 42;
    });
    var c = new Chart(el, {
      type: type, data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } },
          tooltip: { callbacks: { label: function (ctx) { var v = ctx.parsed.y !== undefined ? ctx.parsed.y : ctx.parsed; return ' ' + ctx.dataset.label + ': ' + (o.money ? money(v) : (o.pct ? v + '%' : num(v))); } } } },
        scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { beginAtZero: true, grid: { color: '#EEF2F7' }, ticks: { precision: 0, callback: function (v) { return o.money ? (v >= 1000 ? (v / 1000) + 'k' : v) : (o.pct ? v + '%' : v); } }, max: o.pct ? 100 : undefined } }
      }
    });
    state.charts.push(c);
  }
  function monthLabel(k) { var p = k.split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0].slice(2); }

  /* ---------- export ---------- */
  function exportRows(rows, filename, format) {
    if (!rows.length) { toast('Nothing to export', 'error'); return; }
    var cols = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); }); });
    var safe = function (v) { var s = v === null || v === undefined ? '' : String(v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }; // CSV/Excel injection guard
    if (format === 'xlsx' && window.XLSX) {
      var ws = XLSX.utils.json_to_sheet(rows.map(function (r) { var o = {}; cols.forEach(function (c) { o[c] = safe(r[c]); }); return o; }), { header: cols });
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Data');
      XLSX.writeFile(wb, filename + '.xlsx');
      return;
    }
    var csv = [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return '"' + safe(r[c]).replace(/"/g, '""') + '"'; }).join(','); })).join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportModal(defaultDataset) {
    var companies = (state.meta.companies || []).map(function (c) { return { value: c.id, label: c.name }; });
    formModal({
      title: 'Export records', size: 'sm', submitLabel: 'Download',
      body: field({ name: 'dataset', label: 'Dataset', type: 'select', required: true, value: defaultDataset || 'clients', options: [
        { value: 'clients', label: 'Clients (with journey status)' }, { value: 'refills', label: 'Refill records' }, { value: 'payments', label: 'Payment transactions' },
        { value: 'schedules', label: 'Refill schedule' }, { value: 'reschedules', label: 'Reschedule history' }, { value: 'notes', label: 'Client notes' },
        { value: 'doctorNotes', label: 'Doctor notes' }, { value: 'audit', label: 'Audit log' }] }) +
        field({ name: 'companyId', label: 'Company', type: 'select', options: companies, placeholder: 'All companies' }) +
        field({ name: 'format', label: 'Format', type: 'select', required: true, value: 'xlsx', options: [{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV' }] }),
      onSubmit: function (d) {
        return api('export.dataset', { dataset: d.dataset, companyId: d.companyId }).then(function (r) {
          exportRows(r.rows, 'glp1-' + d.dataset + '-' + todayStr(), d.format);
          toast('Exported ' + r.rows.length + ' rows', 'success');
        });
      }
    });
  }

  /* ===========================================================================
   * 5. AUTHENTICATION
   * ========================================================================= */
  function saveSession(token, user) {
    state.token = token; state.user = user;
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) {}
    scheduleExpiry(user.expiresAt);
  }
  function clearSession() {
    state.token = null; state.user = null; state.meta = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    clearTimeout(state.expiryTimer);
  }
  function scheduleExpiry(iso) {
    clearTimeout(state.expiryTimer);
    var ms = new Date(iso).getTime() - Date.now();
    if (ms > 0 && ms < 864e5) state.expiryTimer = setTimeout(function () { sessionExpired('Your session has expired. Please sign in again.'); }, ms);
  }
  function sessionExpired(msg) {
    clearSession();
    while (modalStack.length) modalStack[modalStack.length - 1].close();
    showLogin(msg);
  }
  function showLogin(msg) {
    destroyCharts();
    $('#app').hidden = true; $('#login-screen').hidden = false;
    var err = $('#login-error');
    if (msg) { err.textContent = msg; err.hidden = false; } else err.hidden = true;
    if (isAdmin()) initGoogleButton();
  }
  function loginError(msg) { var e = $('#login-error'); e.textContent = msg; e.hidden = false; }

  var gsiTries = 0;
  function initGoogleButton() {
    if (!window.google || !google.accounts || !google.accounts.id) {
      if (gsiTries++ < 50) return setTimeout(initGoogleButton, 200);
      return loginError('Google Sign-In could not load. Check your connection or browser extensions and reload.');
    }
    if (!CFG.GOOGLE_CLIENT_ID || CFG.GOOGLE_CLIENT_ID.indexOf('PASTE_') >= 0) return loginError('GOOGLE_CLIENT_ID is not configured in config.js');
    google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onGoogleCredential, auto_select: false, cancel_on_tap_outside: true, ux_mode: 'popup' });
    google.accounts.id.renderButton($('#gsi-button'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 300 });
  }
  function onGoogleCredential(resp) {
    $('#login-error').hidden = true;
    api('auth.adminGoogle', { idToken: resp.credential }, { silentAuth: true })
      .then(function (d) { saveSession(d.token, d.user); return startApp(); })
      .catch(function (e) { loginError(e.message); });
  }
  function bindPartnerLogin() {
    var form = $('#partner-login-form');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var d = readForm(form), btn = $('button[type=submit]', form);
      if (!d.username || !form.password.value) return loginError('Enter your username and password');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Signing in…';
      $('#login-error').hidden = true;
      api('auth.partnerLogin', { username: d.username, password: form.password.value }, { silentAuth: true })
        .then(function (r) { form.password.value = ''; saveSession(r.token, r.user); return startApp(); })
        .catch(function (err) { loginError(err.message); })
        .finally(function () { btn.disabled = false; btn.textContent = 'Sign in'; });
    });
  }
  function logout() {
    var t = state.token;
    if (t) api('auth.logout', {}, { silentAuth: true }).catch(function () {});
    clearSession();
    if (isAdmin() && window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    showLogin('You have been signed out.');
  }
  var pwModalOpen = false;
  function changePasswordModal(forced) {
    if (pwModalOpen) return;
    pwModalOpen = true;
    var m = formModal({
      title: forced ? 'Set your new password' : 'Change password', size: 'sm', submitLabel: 'Update password',
      subtitle: forced ? 'For security, replace the temporary password issued by Justlife before continuing.' : '',
      body: field({ name: 'currentPassword', label: forced ? 'Temporary password' : 'Current password', type: 'password', required: true, attrs: ' autocomplete="current-password"' }) +
        field({ name: 'newPassword', label: 'New password', type: 'password', required: true, hint: 'At least 10 characters with letters and numbers', attrs: ' autocomplete="new-password"' }) +
        field({ name: 'confirm', label: 'Confirm new password', type: 'password', required: true, attrs: ' autocomplete="new-password"' }),
      onSubmit: function (d) {
        if (d.newPassword !== d.confirm) throw new Error('The new passwords do not match');
        return api('auth.changePassword', { currentPassword: d.currentPassword, newPassword: d.newPassword }).then(function (r) {
          state.user.mustChangePassword = false; toast('Password updated', 'success');
          if (forced) startApp();
        });
      }
    });
    var close = m.close;
    m.close = function () { pwModalOpen = false; close(); if (forced && state.user && state.user.mustChangePassword) logout(); };
    $$('[data-close]', m.wrap).forEach(function (b) { b.replaceWith(b.cloneNode(true)); });
    $$('[data-close]', m.wrap).forEach(function (b) { b.addEventListener('click', m.close); });
  }

  /* ===========================================================================
   * 6. SHELL + ROUTER
   * ========================================================================= */
  var NAV = {
    admin: [
      { section: 'Overview' },
      { id: 'dashboard', label: 'Performance', ico: '📊' },
      { id: 'clients', label: 'Clients', ico: '👥' },
      { id: 'refills', label: 'Refills & Reminders', ico: '💊', count: 'overdue' },
      { id: 'payments', label: 'Upsell & Payments', ico: '💳' },
      { id: 'upsell', label: 'Upsell Creation', ico: '🧾', count: 'upsellPending' },
      { section: 'Administration' },
      { id: 'companies', label: 'Companies & Partners', ico: '🏥' },
      { id: 'admins', label: 'Admin Users', ico: '🛡️' },
      { id: 'audit', label: 'Audit Log', ico: '📜' },
      { id: 'settings', label: 'Settings', ico: '⚙️' }
    ],
    partner: [
      { id: 'dashboard', label: 'Dashboard', ico: '🏠' },
      { id: 'clients', label: 'Clients', ico: '👥' },
      { id: 'refills', label: 'Refills', ico: '💊', count: 'overdue' },
      { id: 'notifications', label: 'Reminders', ico: '🔔', count: 'unread' },
      { id: 'account', label: 'My Account', ico: '👤' }
    ]
  };
  var VIEWS = {};

  function startApp() {
    if (state.user && state.user.mustChangePassword) { $('#login-screen').hidden = true; changePasswordModal(true); return Promise.resolve(); }
    return api('meta.options').then(function (meta) {
      state.meta = meta;
      $('#login-screen').hidden = true; $('#app').hidden = false;
      renderNav(); renderUserBox();
      if ($('#brand-company')) $('#brand-company').textContent = state.user.companyName || 'Partner Portal';
      route();
    }).catch(function (e) { if (e.code !== 'AUTH') showLogin(e.message); });
  }
  function renderNav(counts) {
    counts = counts || state.navCounts || {};
    state.navCounts = counts;
    $('#nav').innerHTML = NAV[PORTAL].map(function (n) {
      if (n.section) return '<div class="nav-section">' + esc(n.section) + '</div>';
      var c = n.count && counts[n.count] ? '<span class="count">' + esc(counts[n.count]) + '</span>' : '';
      return '<a href="#/' + n.id + '" data-nav="' + n.id + '" class="' + (state.view === n.id ? 'active' : '') + '"><span class="ico" aria-hidden="true">' + n.ico + '</span>' + esc(n.label) + c + '</a>';
    }).join('');
  }
  function renderUserBox() {
    var u = state.user;
    $('#user-box').innerHTML = '<div><div class="name">' + esc(u.name) + '</div><div class="meta">' + esc(isAdmin() ? u.email + ' · ' + u.role : u.companyName) + '</div></div>' +
      '<button class="btn btn-sm" data-action="logout">Sign out</button>';
  }
  function setHeader(title, sub, actions) {
    $('#view-title').textContent = title;
    $('#view-sub').textContent = sub || '';
    $('#topbar-actions').innerHTML = actions || '';
    document.title = title + ' · ' + (isAdmin() ? 'Admin' : 'Partner') + ' · ' + (CFG.APP_NAME || 'GLP-1 CRM');
  }
  function route() {
    if (!state.user || !state.meta) return; // not signed in / still booting
    var h = (location.hash || '').replace(/^#\/?/, '');
    var parts = h.split('?'), id = parts[0] || 'dashboard';
    if (!VIEWS[PORTAL][id]) id = 'dashboard';
    state.params = {};
    (parts[1] || '').split('&').forEach(function (kv) { if (kv) { var p = kv.split('='); state.params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); } });
    state.view = id;
    destroyCharts();
    renderNav();
    $('#app').classList.remove('nav-open');
    $('#view').innerHTML = skeleton(4);
    window.scrollTo(0, 0);
    state.refresh = function () { VIEWS[PORTAL][id]($('#view')); };
    state.refresh();
    refreshCounts();
  }
  function go(id, params) {
    var q = params ? '?' + Object.keys(params).filter(function (k) { return params[k] !== '' && params[k] !== undefined; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&') : '';
    var target = '#/' + id + (q.length > 1 ? q : '');
    if (location.hash === target) route(); else location.hash = target;
  }
  window.addEventListener('hashchange', route);
  function refreshCounts() {
    var calls = [api('dashboard.summary', {})];
    if (isAdmin()) calls.push(api('upsell.list', { preset: 'all', upsellStatus: 'Pending' }));
    Promise.all(calls).then(function (r) {
      var s = r[0], up = r[1];
      renderNav({ overdue: s.refillsOverdue, unread: s.unreadNotifications, upsellPending: up ? up.counts.registrations.pending + up.counts.refills.pending : 0 });
    }).catch(function () {});
  }
  function refreshAll() { if (state.refresh) state.refresh(); refreshCounts(); }

  /* ---------- global click delegation (no inline handlers → strict CSP) ---------- */
  var ACTIONS = {
    'logout': logout,
    'toggle-sidebar': function () { $('#app').classList.toggle('nav-open'); },
    'reload-view': function () { refreshAll(); },
    'open-client': function (el) { openClientProfile(el.getAttribute('data-id')); },
    'register-client': function () { registerClientModal(); },
    'record-refill': function (el) { withClient(el.getAttribute('data-id'), refillModal); },
    'reschedule': function (el) { withClient(el.getAttribute('data-id'), rescheduleModal); },
    'go': function (el) { var p = {}; var raw = el.getAttribute('data-params'); if (raw) { try { p = JSON.parse(raw); } catch (e) {} } go(el.getAttribute('data-view'), p); },
    'export': function (el) { exportModal(el.getAttribute('data-dataset')); },
    'change-password': function () { changePasswordModal(false); }
  };
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var fn = ACTIONS[el.getAttribute('data-action')];
    if (fn) { e.preventDefault(); e.stopPropagation(); fn(el, e); }
  });
  function withClient(clientId, fn) {
    api('client.get', { clientId: clientId }).then(function (p) { fn(p); }).catch(function (e) { toast(e.message, 'error'); });
  }

  /* ===========================================================================
   * 7. CLIENT LIST (shared Admin + Partner)
   * ========================================================================= */
  var STATUS_OPTIONS = ['Not Started', 'Active', 'Paused', 'Overdue', 'Stopped', 'Completed'];
  var REFILL_STATUS_OPTIONS = ['Overdue', 'Due Today', 'Upcoming', 'All Refills Done', 'Paused', 'Stopped', 'Completed'];

  function clientsTable(rows, opt) {
    opt = opt || {};
    if (!rows.length) return emptyState(opt.emptyText || 'No clients match these filters.', '🔍');
    var h = '<div class="table-wrap"><table class="table"><thead><tr><th>Client</th>' + (isAdmin() ? '<th>Company</th>' : '') +
      '<th>Medication</th><th>Journey</th><th>Status</th><th>Next refill</th><th>Registered</th>' + (opt.actions ? '<th></th>' : '') + '</tr></thead><tbody>';
    rows.forEach(function (c) {
      h += '<tr class="clickable" data-action="open-client" data-id="' + esc(c.clientId) + '">' +
        '<td><div class="cell-title">' + esc(c.fullName) + '</div><div class="cell-sub">' + esc(c.externalClientId) + ' · ' + esc(c.phone) + '</div></td>' +
        (isAdmin() ? '<td>' + esc(c.companyName) + '</td>' : '') +
        '<td><div>' + esc(c.medicationName) + '</div><div class="cell-sub">' + esc(c.medicationType) + ' · ' + esc(c.dosage) + '</div></td>' +
        '<td>' + journeyBar(c.journey) + '</td>' +
        '<td>' + statusBadge(c.journey) + '</td>' +
        '<td>' + refillChip(c.journey) + '</td>' +
        '<td class="nowrap">' + fmtDate(c.registrationDate) + '</td>' +
        (opt.actions ? '<td class="nowrap">' + (c.journey.nextScheduleId && ['Active', 'Overdue', 'Not Started'].indexOf(c.journey.status) >= 0 ? '<button class="btn btn-sm btn-success" data-action="record-refill" data-id="' + esc(c.clientId) + '">+ Refill</button>' : '') + '</td>' : '') +
        '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function viewClients(root) {
    var p = state.params;
    var meds = state.meta.medications, companies = (state.meta.companies || []).map(function (c) { return { value: c.id, label: c.name }; });
    setHeader('Clients', isAdmin() ? 'All partner companies' : state.user.companyName,
      (isAdmin() ? '<button class="btn" data-action="export" data-dataset="clients">⬇ <span class="lbl">Export</span></button>' : '') +
      '<button class="btn btn-primary" data-action="register-client">＋ <span class="lbl">Register client</span></button>');
    root.innerHTML = '<div class="card"><div class="card-body"><form class="toolbar" id="client-filters">' +
      field({ name: 'q', label: 'Search', value: p.q, placeholder: 'Name, client ID, booking ref, phone', attrs: ' type="search"' }).replace('class="field', 'class="field search') +
      (isAdmin() ? field({ name: 'companyId', label: 'Company', type: 'select', options: companies, value: p.companyId, placeholder: 'All companies' }) : '') +
      field({ name: 'medicationName', label: 'Medication', type: 'select', options: meds, value: p.medicationName, placeholder: 'All medications' }) +
      field({ name: 'medicationType', label: 'Injection / pills', type: 'select', options: state.meta.medicationTypes, value: p.medicationType, placeholder: 'All types' }) +
      field({ name: 'status', label: 'Journey status', type: 'select', options: STATUS_OPTIONS, value: p.status, placeholder: 'All statuses' }) +
      (isAdmin() ? field({ name: 'refillStatus', label: 'Refill status', type: 'select', options: REFILL_STATUS_OPTIONS, value: p.refillStatus, placeholder: 'Any' }) +
        field({ name: 'regFrom', label: 'Registered from', type: 'date', value: p.regFrom }) + field({ name: 'regTo', label: 'Registered to', type: 'date', value: p.regTo }) +
        field({ name: 'awaitingReview', label: 'Awaiting completion review', type: 'checkbox', value: p.awaitingReview === 'true' }) : '') +
      '<button type="button" class="btn btn-ghost" data-clear>Clear</button></form></div></div>' +
      '<div class="card"><div class="card-head"><h2>Client list</h2><span class="muted small" id="client-count"></span></div><div class="card-body" style="padding-bottom:6px">' + journeyLegend() + '</div><div class="card-body flush" id="client-table">' + skeleton(1) + '</div></div>';
    var form = $('#client-filters');
    var load = function () {
      var f = readForm(form);
      if (!isAdmin()) { delete f.companyId; }
      api('client.list', f).then(function (r) {
        $('#client-table').innerHTML = clientsTable(r.clients, { actions: true });
        $('#client-count').textContent = r.total + ' client' + (r.total === 1 ? '' : 's');
      }).catch(function (e) { $('#client-table').innerHTML = errorBlock(e); });
    };
    form.addEventListener('input', debounce(load, 350));
    form.addEventListener('change', load);
    $('[data-clear]', form).addEventListener('click', function () { $$('input,select', form).forEach(function (el) { if (el.type === 'checkbox') el.checked = false; else el.value = ''; }); load(); });
    load();
  }

  /* ===========================================================================
   * 8. CLIENT PROFILE (complete history)
   * ========================================================================= */
  var activeProfile = null;
  function openClientProfile(clientId) {
    var m = modal({ title: 'Client profile', size: 'xl', body: skeleton(3), noAutofocus: true, onClose: function () { activeProfile = null; } });
    activeProfile = { id: clientId, modal: m, tab: 'overview' };
    loadProfile();
  }
  function loadProfile() {
    if (!activeProfile) return;
    var ap = activeProfile;
    api('client.get', { clientId: ap.id }).then(function (p) { if (activeProfile === ap) renderProfile(p); })
      .catch(function (e) { ap.modal.body(errorBlock(e)); });
  }
  function afterChange(msg) { toast(msg, 'success'); loadProfile(); refreshAll(); }

  function renderProfile(p) {
    var ap = activeProfile, v = p.view, j = v.journey, c = p.client, m = ap.modal;
    $('.modal-head h2', m.el).textContent = v.fullName;
    var canRefill = j.nextScheduleId && ['Active', 'Overdue', 'Not Started'].indexOf(j.status) >= 0;
    var canResched = j.nextScheduleId && ['Stopped', 'Completed'].indexOf(j.status) < 0;
    var actions = (canRefill ? '<button class="btn btn-success" data-p="refill">＋ Record refill</button>' : '') +
      (canResched ? '<button class="btn" data-p="reschedule">📅 Reschedule</button>' : '') +
      (['Stopped', 'Completed'].indexOf(j.status) < 0 ? '<button class="btn" data-p="medication">💊 Update medication</button>' : '') +
      (j.status !== 'Stopped' ? '<button class="btn ' + (j.awaitingReview || j.status === 'Completed' ? 'btn-blue' : '') + '" data-p="extend">⏩ Extend journey</button>' : '') +
      '<button class="btn" data-p="note">📝 Add note</button><button class="btn" data-p="doctor">🩺 Doctor note</button>';
    if (isAdmin()) {
      actions += '<button class="btn" data-p="edit">✏️ Edit client</button>';
      if (j.storedStatus === 'Active') actions += '<button class="btn" data-p="pause">⏸ Pause</button><button class="btn btn-danger" data-p="stop">⏹ Stop</button>';
      if (j.storedStatus === 'Paused' || j.storedStatus === 'Stopped') actions += '<button class="btn btn-blue" data-p="reactivate">▶ Reactivate</button>' + (j.storedStatus === 'Paused' ? '<button class="btn btn-danger" data-p="stop">⏹ Stop</button>' : '');
      if (j.storedStatus !== 'Completed' && j.storedStatus !== 'Stopped') actions += '<button class="btn ' + (j.awaitingReview ? 'btn-primary' : '') + '" data-p="complete">✅ Confirm completion</button>';
    }
    var tabs = [['overview', 'Overview'], ['refills', 'Refills (' + p.refills.length + ')'], ['payments', 'Payments (' + p.payments.length + ')'], ['timeline', 'Full history'], ['notes', 'Notes (' + (p.notes.length + p.doctorNotes.length) + ')'], ['reschedules', 'Reschedules (' + p.reschedules.length + ')']];
    if (isAdmin()) tabs.push(['audit', 'Audit (' + (p.audit || []).length + ')']);

    var html = '<div class="profile-head"><div class="avatar">' + esc(initials(v.fullName)) + '</div><div class="grow">' +
      '<div class="row">' + statusBadge(j) + (j.refillStatus ? badge('Refill: ' + j.refillStatus, REFILL_CLS[j.refillStatus] || 'grey') : '') + '</div>' +
      '<div class="muted small" style="margin-top:6px">Client ID <b>' + esc(v.externalClientId) + '</b> · ' + esc(v.phone) + (isAdmin() ? ' · ' + esc(v.companyName) : '') + ' · Internal ' + esc(v.clientId) + '</div></div></div>' +
      (j.awaitingReview ? '<div class="alert alert-warn">All ' + j.months + ' journey months have been supplied. ' + (isAdmin() ? 'Review the history and confirm completion.' : 'Justlife will review and confirm completion.') + '</div>' : '') +
      (j.statusReason && ['Paused', 'Stopped'].indexOf(j.status) >= 0 ? '<div class="alert alert-info">' + esc(j.status) + ': ' + esc(j.statusReason) + '</div>' : '') +
      '<div class="profile-actions">' + actions + '</div>' +
      '<div class="tabs" role="tablist">' + tabs.map(function (t) { return '<button class="tab ' + (ap.tab === t[0] ? 'active' : '') + '" data-tab="' + t[0] + '" role="tab">' + esc(t[1]) + '</button>'; }).join('') + '</div>' +
      '<div id="profile-tab">' + profileTab(ap.tab, p) + '</div>';
    m.body(html);
    $$('[data-tab]', m.el).forEach(function (b) {
      b.addEventListener('click', function () {
        ap.tab = b.getAttribute('data-tab');
        $$('[data-tab]', m.el).forEach(function (x) { x.classList.toggle('active', x === b); });
        $('#profile-tab', m.el).innerHTML = profileTab(ap.tab, p);
        bindProfileTab(p);
      });
    });
    var handlers = {
      refill: function () { refillModal(p); }, reschedule: function () { rescheduleModal(p); }, medication: function () { medicationModal(p); },
      note: function () { noteModal(p); }, doctor: function () { doctorNoteModal(p); }, edit: function () { editClientModal(p); },
      pause: function () { journeyStatusModal(p, 'Paused'); }, stop: function () { journeyStatusModal(p, 'Stopped'); }, reactivate: function () { journeyStatusModal(p, 'Active'); },
      complete: function () { completionModal(p); }, extend: function () { extendModal(p); }
    };
    $$('[data-p]', m.el).forEach(function (b) { b.addEventListener('click', handlers[b.getAttribute('data-p')]); });
    bindProfileTab(p);
  }

  function bindProfileTab(p) {
    var m = activeProfile && activeProfile.modal;
    if (!m) return;
    $$('[data-edit-refill]', m.el).forEach(function (b) { b.addEventListener('click', function () { editRefillModal(p, p.refills.filter(function (r) { return r.Refill_ID === b.getAttribute('data-edit-refill'); })[0]); }); });
    $$('[data-edit-payment]', m.el).forEach(function (b) { b.addEventListener('click', function () { editPaymentModal(p.payments.filter(function (x) { return x.Transaction_ID === b.getAttribute('data-edit-payment'); })[0], function () { afterChange('Payment updated'); }); }); });
  }

  function kv(pairs) { return '<dl class="kv">' + pairs.map(function (x) { return '<div><dt>' + esc(x[0]) + '</dt><dd>' + (x[2] ? x[1] : esc(x[1] === '' || x[1] === undefined ? '—' : x[1])) + '</dd></div>'; }).join('') + '</dl>'; }

  function profileTab(tab, p) {
    var v = p.view, j = v.journey, c = p.client;
    if (tab === 'overview') {
      return '<div class="card"><div class="card-head"><h2>' + (j.months === 6 ? 'Six' : j.months) + '-month journey</h2><span class="muted small">' + fmtDate(j.startDate) + ' → ' + fmtDate(j.endDate) + '</span></div><div class="card-body stack">' +
        journeyBar(j, true) +
        kv([['Journey start', fmtDate(j.startDate), 1], ['Expected end', fmtDate(j.endDate), 1], ['Current month', j.currentMonth ? j.currentMonth + ' of ' + j.months : 'Not started'],
          ['Completed months', j.completedMonths], ['Remaining months', j.remainingMonths], ['Months supplied', j.milestones + ' of ' + j.months],
          ['Journey length', j.months + ' months' + (p.journey && Number(p.journey.Extension_Count) ? ' (extended ' + p.journey.Extension_Count + '× from ' + p.journey.Original_Duration_Months + ')' : '')],
          ['Completion', j.percent + '%'], ['Next refill', j.nextRefillDate ? fmtDate(j.nextRefillDate) + ' (refill #' + j.nextRefillCycle + ')' : '—', 1], ['Journey status', statusBadge(j), 1]]) +
        (p.journey && p.journey.Completion_Confirmed === 'TRUE' ? '<div class="alert alert-success">Completion confirmed by ' + esc(p.journey.Completion_Confirmed_By) + ' on ' + fmtDateTime(p.journey.Completion_Confirmed_At) + '. ' + esc(p.journey.Completion_Note) + '</div>' : '') +
        '</div></div>' +
        '<div class="grid-2"><div class="card"><div class="card-head"><h2>Client & registration</h2></div><div class="card-body">' +
        kv([['Full name', c.Full_Name], ['Phone', c.Phone], ['Client ID', c.External_Client_ID], ['First booking ref', c.First_Booking_Ref], ['Registered', fmtDate(c.Registration_Date), 1],
          ['Registered by', c.Created_By_Name], ['Partner company', v.companyName], ['Refill interval', c.Refill_Interval_Days + ' days']]) +
        '</div></div><div class="card"><div class="card-head"><h2>Initial measurements</h2></div><div class="card-body">' +
        kv([['Height', c.Height_Cm + ' cm'], ['Weight', c.Weight_Kg + ' kg'], ['BMI', c.BMI]]) + '</div></div></div>' +
        '<div class="grid-2"><div class="card"><div class="card-head"><h2>Starting medication</h2></div><div class="card-body">' +
        kv([['Type', c.Initial_Medication_Type], ['Medication', c.Initial_Medication_Name], ['Prescribed dosage', c.Prescribed_Dosage], ['Starting dosage', c.Starting_Dosage], ['Quantity', c.Initial_Quantity], ['Doctor', c.Doctor_Name]]) +
        (c.Prescription_Notes ? '<div class="note-card" style="margin-top:12px"><div class="meta">Prescription notes</div><div class="body">' + esc(c.Prescription_Notes) + '</div></div>' : '') +
        '</div></div><div class="card"><div class="card-head"><h2>Current medication</h2></div><div class="card-body">' +
        kv([['Type', c.Current_Medication_Type], ['Medication', c.Current_Medication_Name], ['Dosage', c.Current_Dosage], ['Refills completed', v.refillsCompleted], ['Total paid', money(v.totalPaid)]]) + '</div></div></div>';
    }
    if (tab === 'refills') {
      var sched = '<div class="card"><div class="card-head"><h2>Refill schedule</h2><span class="muted small">Original dates are always preserved</span></div><div class="card-body flush"><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Original date</th><th>Current date</th><th>Status</th><th>Reschedules</th><th>Completed</th></tr></thead><tbody>' +
        (p.schedules.length ? p.schedules.map(function (s) {
          var st = s.Status === 'Scheduled' ? (s.Current_Expected_Date < todayStr() ? 'Overdue' : 'Upcoming') : s.Status;
          return '<tr><td>' + esc(s.Cycle_Number) + '</td><td>' + fmtDate(s.Original_Expected_Date) + '</td><td>' + fmtDate(s.Current_Expected_Date) + '</td><td>' + badge(st, REFILL_CLS[st] || slug(st)) + '</td><td>' + esc(s.Reschedule_Count || 0) + '</td><td>' + fmtDate(s.Completed_Date) + '</td></tr>';
        }).join('') : '<tr><td colspan="6">' + emptyState('No refill schedule') + '</td></tr>') + '</tbody></table></div></div></div>';
      var rec = '<div class="card"><div class="card-head"><h2>Refill records</h2></div><div class="card-body flush">' + (p.refills.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Date</th><th>Timing</th><th>Booking ref</th><th>Medication</th><th>Dosage</th><th>Qty</th><th class="num">Amount</th><th>Payment</th><th>Next refill</th><th>Doctor</th><th>By</th>' + (isAdmin() ? '<th></th>' : '') + '</tr></thead><tbody>' +
        p.refills.map(function (r) {
          return '<tr><td>' + esc(r.Cycle_Number) + '</td><td class="nowrap">' + fmtDate(r.Refill_Date) + '<div class="cell-sub">exp. ' + fmtDate(r.Expected_Date) + '</div></td><td>' + badge(r.Timing, /^Early/.test(r.Timing) ? 'active' : (/^Late/.test(r.Timing) ? 'orange' : 'green')) + '</td>' +
            '<td>' + esc(r.Booking_Ref) + '</td><td>' + esc(r.Medication_Name) + '<div class="cell-sub">' + esc(r.Medication_Type) + (r.Medication_Changed === 'TRUE' ? ' · <b>changed</b>' : '') + '</div></td><td>' + esc(r.Dosage) + (r.Dosage_Changed === 'TRUE' ? ' <span class="badge b-orange plain">changed</span>' : '') + '</td><td>' + esc(r.Quantity) + '</td>' +
            '<td class="num">' + money(r.Amount_Collected) + '</td><td>' + (r.Payment_Status ? badge(r.Payment_Status) : '—') + '</td><td class="nowrap">' + fmtDate(r.Next_Refill_Date) + '</td><td>' + esc(r.Doctor_Name || '—') + '</td>' +
            '<td>' + esc(r.Created_By_Name) + (r.Record_Status === 'Corrected' ? '<div class="cell-sub">corrected</div>' : '') + '</td>' + (isAdmin() ? '<td><button class="btn btn-sm" data-edit-refill="' + esc(r.Refill_ID) + '">Edit</button></td>' : '') + '</tr>' +
            (r.Partner_Notes || r.Doctor_Notes ? '<tr><td></td><td colspan="' + (isAdmin() ? 12 : 11) + '" class="cell-sub">' + (r.Partner_Notes ? '📝 ' + esc(r.Partner_Notes) : '') + (r.Doctor_Notes ? '  🩺 ' + esc(r.Doctor_Notes) : '') + '</td></tr>' : '');
        }).join('') + '</tbody></table></div>' : emptyState('No refills recorded yet', '💊')) + '</div></div>';
      return '<div class="stack">' + sched + rec + '</div>';
    }
    if (tab === 'payments') {
      if (!p.payments.length) return emptyState('No payments recorded', '💳');
      return '<div class="table-wrap"><table class="table"><thead><tr><th>Transaction</th><th>Type</th><th>Booking ref</th><th>Medication</th><th class="num">Amount</th><th>Payment date</th><th>Status</th><th>Reference</th><th>By</th>' + (isAdmin() ? '<th></th>' : '') + '</tr></thead><tbody>' +
        p.payments.map(function (x) {
          return '<tr><td class="mono">' + esc(x.Transaction_ID) + '</td><td>' + esc(x.Transaction_Type) + '</td><td>' + esc(x.Booking_Ref) + '</td><td>' + esc(x.Medication_Name) + '</td><td class="num strong">' + money(x.Amount, x.Currency) + '</td>' +
            '<td class="nowrap">' + fmtDate(x.Payment_Date) + '</td><td>' + badge(x.Payment_Status) + '</td><td>' + esc(x.Payment_Ref || '—') + '</td><td>' + esc(x.Created_By_Name) + '<div class="cell-sub">' + fmtDateTime(x.Created_At) + '</div></td>' +
            (isAdmin() ? '<td><button class="btn btn-sm" data-edit-payment="' + esc(x.Transaction_ID) + '">Correct</button></td>' : '') + '</tr>';
        }).join('') + '</tbody></table></div>';
    }
    if (tab === 'timeline') {
      if (!p.timeline.length) return emptyState('No history yet');
      return '<ul class="timeline">' + p.timeline.map(function (e) {
        return '<li class="t-' + esc(e.type) + '"><span class="dot"></span><div class="when">' + fmtDateTime(e.at) + (e.by ? ' · ' + esc(e.by) : '') + (e.internal ? ' · <span class="badge b-review plain">Internal</span>' : '') + '</div><div class="what">' + esc(e.title) + '</div><div class="detail">' + esc(e.detail) + '</div></li>';
      }).join('') + '</ul>';
    }
    if (tab === 'notes') {
      var docs = p.doctorNotes.slice().reverse().map(function (n) { return '<div class="note-card"><div class="meta">🩺 ' + esc(n.Doctor_Name || 'Doctor') + ' · ' + esc(n.Related_Type) + ' · ' + fmtDateTime(n.Created_At) + ' · entered by ' + esc(n.Created_By_Name) + '</div><div class="body">' + esc(n.Note) + '</div></div>'; }).join('');
      var notes = p.notes.slice().reverse().map(function (n) { return '<div class="note-card ' + (n.Visibility === 'Internal' ? 'internal' : '') + '"><div class="meta">' + esc(n.Note_Type.replace(/_/g, ' ')) + (n.Visibility === 'Internal' ? ' · INTERNAL (admin only)' : '') + ' · ' + fmtDateTime(n.Created_At) + ' · ' + esc(n.Created_By_Name) + '</div><div class="body">' + esc(n.Note) + '</div></div>'; }).join('');
      return '<div class="grid-2"><div><h3 style="margin-bottom:10px">Doctor notes</h3>' + (docs || emptyState('No doctor notes', '🩺')) + '</div><div><h3 style="margin-bottom:10px">Partner & admin notes</h3>' + (notes || emptyState('No notes', '📝')) + '</div></div>';
    }
    if (tab === 'reschedules') {
      if (!p.reschedules.length) return emptyState('This client has never been rescheduled', '📅');
      return '<div class="table-wrap"><table class="table"><thead><tr><th>Refill #</th><th>Original date</th><th>Previous date</th><th>New date</th><th>Reason</th><th>Note</th><th>By</th><th>When</th></tr></thead><tbody>' +
        p.reschedules.slice().reverse().map(function (r) {
          return '<tr><td>' + esc(r.Cycle_Number) + '</td><td>' + fmtDate(r.Original_Expected_Date) + '</td><td>' + fmtDate(r.Previous_Date) + '</td><td class="strong">' + fmtDate(r.New_Date) + '</td><td>' + esc(r.Reason_Category) + (r.Reason ? '<div class="cell-sub">' + esc(r.Reason) + '</div>' : '') + '</td><td>' + esc(r.Note) + '</td><td>' + esc(r.Created_By_Name) + '</td><td class="nowrap">' + fmtDateTime(r.Created_At) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if (tab === 'audit') return auditTable(p.audit || []);
    return '';
  }

  /* ===========================================================================
   * 9. FORMS: registration, refill, reschedule, medication, notes
   * ========================================================================= */
  function medFields(prefix, cur, disabled) {
    return [
      { name: 'medicationType', label: 'Medication type', type: 'select', required: true, options: state.meta.medicationTypes, value: cur.type, disabled: disabled },
      { name: 'medicationName', label: 'Medication name', type: 'select', required: true, options: state.meta.medications, value: cur.name, disabled: disabled }
    ];
  }

  function registerClientModal() {
    var t = todayStr(), m = state.meta;
    var companies = (m.companies || []).filter(function (c) { return c.status === 'Active'; }).map(function (c) { return { value: c.id, label: c.name }; });
    formModal({
      title: 'Register new GLP-1 client', size: 'lg', submitLabel: 'Register client',
      subtitle: 'A six-month journey and the first refill date are created automatically.',
      body:
        section('Client details', [
          { name: 'fullName', label: 'Client full name', required: true, maxlength: 120 },
          { name: 'phone', label: 'Client phone number', required: true, type: 'tel', placeholder: '+971 50 123 4567', maxlength: 30 },
          { name: 'externalClientId', label: 'Client ID', required: true, maxlength: 60 },
          { name: 'firstBookingRef', label: 'First booking reference ID', required: true, maxlength: 60 },
          { name: 'registrationDate', label: 'Registration date', value: t, readonly: true, hint: 'Set automatically' },
          { name: 'journeyStartDate', label: 'Starting date of GLP journey', type: 'date', required: true, value: t },
          isAdmin() ? { name: 'companyId', label: 'Partner company', type: 'select', required: true, options: companies } : { name: 'companyLabel', label: 'Partner company', value: state.user.companyName, readonly: true, hint: 'Assigned from your login' },
          { name: 'refillIntervalDays', label: 'Refill interval (days)', type: 'number', value: m.defaultRefillIntervalDays, min: 7, max: 120, hint: 'Individual schedule for this client' },
          { name: 'heightCm', label: 'Height (cm)', type: 'number', required: true, min: 50, max: 250, step: '0.1' },
          { name: 'weightKg', label: 'Weight (kg)', type: 'number', required: true, min: 20, max: 400, step: '0.1' },
          { name: 'bmi', label: 'BMI', type: 'number', min: 10, max: 100, step: '0.1', hint: 'Calculated from height & weight — you can adjust' }
        ]) +
        section('Medication details', medFields('', {}).concat([
          { name: 'prescribedDosage', label: 'Prescribed dosage', required: true, placeholder: 'e.g. 5 mg weekly', maxlength: 60 },
          { name: 'startingDosage', label: 'Starting dosage', required: true, placeholder: 'e.g. 2.5 mg', maxlength: 60 },
          { name: 'quantity', label: 'Medicine quantity / amount', required: true, placeholder: 'e.g. 4 pens / 30 tablets', maxlength: 60 },
          { name: 'doctorName', label: "Doctor's name", maxlength: 120 },
          { name: 'prescriptionNotes', label: "Doctor's prescription notes", type: 'textarea', full: true },
          { name: 'partnerNotes', label: 'Registration note (mandatory)', type: 'textarea', required: true, full: true }
        ])) +
        section('Payment details', [
          { name: 'amountCollected', label: 'Amount collected (' + currency() + ')', type: 'number', min: 0, step: '0.01', value: '' },
          { name: 'paymentDate', label: 'Payment collection date', type: 'date', value: t, readonly: !isAdmin(), hint: isAdmin() ? 'Defaults to today' : 'Automatically today' },
          { name: 'paymentRef', label: 'Payment reference', maxlength: 80 },
          { name: 'paymentStatus', label: 'Payment status', type: 'select', options: m.paymentStatuses, value: 'Paid', hint: 'Only “Paid” counts as collected revenue' }
        ]),
      onMount: function (h, form) {
        var calc = function () {
          var hgt = parseFloat(form.heightCm.value), w = parseFloat(form.weightKg.value);
          if (hgt > 0 && w > 0) form.bmi.value = (w / Math.pow(hgt / 100, 2)).toFixed(1);
        };
        form.heightCm.addEventListener('input', calc); form.weightKg.addEventListener('input', calc);
      },
      onSubmit: function (d, rid) {
        delete d.registrationDate; delete d.companyLabel;
        if (!isAdmin()) delete d.paymentDate;
        if (Number(d.amountCollected) > 0 && !d.paymentStatus) throw new Error('Choose a payment status for the amount collected');
        return api('client.register', d, { requestId: rid }).then(function (r) {
          toast(r.duplicate ? 'This registration was already saved' : 'Client registered successfully', 'success');
          refreshAll();
          setTimeout(function () { openClientProfile(r.clientId); }, 200);
        });
      }
    });
  }

  function refillModal(p) {
    var v = p.view, j = v.journey, c = p.client, t = todayStr(), m = state.meta;
    if (!j.nextScheduleId) return toast('No refill is scheduled for this client', 'error');
    var isLast = Number(j.nextRefillCycle) >= j.months - 1;
    var interval = Number(c.Refill_Interval_Days || m.defaultRefillIntervalDays);
    formModal({
      title: 'Record refill #' + j.nextRefillCycle, size: 'lg', submitLabel: 'Save refill',
      subtitle: esc(v.fullName) + ' · ' + esc(v.externalClientId) + ' · expected ' + fmtDate(j.nextRefillDate),
      body:
        section('Refill', [
          { name: 'clientLabel', label: 'Client name & ID', value: v.fullName + ' (' + v.externalClientId + ')', readonly: true },
          { name: 'refillDate', label: 'Refill date', type: 'date', required: true, value: t, max: t },
          { name: 'bookingRefLabel', label: 'Booking reference ID', value: c.First_Booking_Ref, readonly: true, hint: 'Same reference as the first booking' },
          { name: 'quantity', label: 'Medicine amount / quantity', required: true, maxlength: 60 }
        ]) +
        '<div class="form-section"><h3>Medication</h3>' + field({ name: 'noChange', label: 'No change – same medication and dosage (' + c.Current_Medication_Name + ' · ' + c.Current_Dosage + ')', type: 'checkbox', value: true }) +
        '<div class="spacer"></div><div class="form-grid">' +
        medFields('', { type: c.Current_Medication_Type, name: c.Current_Medication_Name }, true).map(field).join('') +
        field({ name: 'dosage', label: 'Dosage', required: true, value: c.Current_Dosage, disabled: true, maxlength: 60 }) + '</div>' +
        '<small class="hint">Medication details are saved on every refill to keep a complete history.</small></div>' +
        section('Payment', [
          { name: 'amountCollected', label: 'Amount collected (' + currency() + ')', type: 'number', min: 0, step: '0.01' },
          { name: 'paymentDate', label: 'Payment collection date', type: 'date', value: t, readonly: !isAdmin(), hint: isAdmin() ? '' : 'Automatically today' },
          { name: 'paymentStatus', label: 'Payment status', type: 'select', options: m.paymentStatuses, value: 'Paid' },
          { name: 'paymentRef', label: 'Payment reference', maxlength: 80 }
        ]) +
        section('Doctor & notes', [
          { name: 'doctorName', label: "Doctor's name", value: c.Doctor_Name, maxlength: 120 },
          isLast ? { name: 'lastInfo', label: 'Next expected refill date', value: 'Final refill of the journey — no further refill scheduled', readonly: true }
            : { name: 'nextRefillDate', label: 'Next expected refill date', type: 'date', required: true, value: addDays(t, interval), hint: 'Default: refill date + ' + interval + ' days' },
          { name: 'doctorNotes', label: "Doctor's notes", type: 'textarea', full: true },
          { name: 'partnerNotes', label: 'Refill note (mandatory)', type: 'textarea', required: true, full: true }
        ]),
      onMount: function (h, form) {
        var toggle = function () {
          var on = form.noChange.checked;
          ['medicationType', 'medicationName', 'dosage'].forEach(function (n) { form[n].disabled = on; });
          if (on) { form.medicationType.value = c.Current_Medication_Type; form.medicationName.value = c.Current_Medication_Name; form.dosage.value = c.Current_Dosage; }
        };
        form.noChange.addEventListener('change', toggle);
        form.refillDate.addEventListener('change', function () { if (form.nextRefillDate && form.refillDate.value) form.nextRefillDate.value = addDays(form.refillDate.value, interval); });
      },
      onSubmit: function (d, rid) {
        delete d.clientLabel; delete d.lastInfo; delete d.bookingRefLabel;
        if (!isAdmin()) delete d.paymentDate;
        d.clientId = v.clientId;
        if (d.noChange) { delete d.medicationType; delete d.medicationName; delete d.dosage; }
        return api('refill.register', d, { requestId: rid }).then(function (r) {
          afterChange(r.duplicate ? 'Refill was already saved' : (r.isLastRefill ? 'Final refill saved – journey awaiting completion review' : 'Refill saved · next refill ' + fmtDate(r.nextRefillDate)));
        });
      }
    });
  }

  function rescheduleModal(p) {
    var j = p.view.journey;
    var sch = p.schedules.filter(function (s) { return s.Schedule_ID === j.nextScheduleId; })[0];
    if (!sch) return toast('No open refill to reschedule', 'error');
    var reasons = state.meta.rescheduleReasons.slice();
    if (isAdmin()) reasons.push('Admin schedule correction');
    formModal({
      title: 'Reschedule refill #' + sch.Cycle_Number, size: 'md', submitLabel: 'Reschedule',
      subtitle: esc(p.view.fullName) + ' · original date ' + fmtDate(sch.Original_Expected_Date) + (Number(sch.Reschedule_Count) ? ' · rescheduled ' + esc(sch.Reschedule_Count) + '×' : ''),
      body: '<div class="form-grid">' +
        field({ name: 'prev', label: 'Previous refill date', value: sch.Current_Expected_Date, readonly: true }) +
        field({ name: 'newDate', label: 'New expected refill date', type: 'date', required: true, min: p.client.Journey_Start_Date }) +
        field({ name: 'reasonCategory', label: 'Reason for rescheduling', type: 'select', required: true, options: reasons, full: true }) +
        field({ name: 'reason', label: 'Reason details', full: true, maxlength: 1000, hint: 'Required when reason is “Other”' }) +
        field({ name: 'note', label: 'Partner note', type: 'textarea', required: true, full: true }) + '</div>' +
        '<div class="alert alert-info">The original expected date and every previous date are kept in the reschedule history.</div>',
      onSubmit: function (d) {
        return api('refill.reschedule', { clientId: p.view.clientId, scheduleId: sch.Schedule_ID, newDate: d.newDate, reasonCategory: d.reasonCategory, reason: d.reason, note: d.note })
          .then(function (r) { afterChange('Refill moved to ' + fmtDate(r.newDate)); });
      }
    });
  }

  function medicationModal(p) {
    var c = p.client;
    formModal({
      title: 'Update medication & dosage', size: 'md', submitLabel: 'Save change', subtitle: 'Current: ' + esc(c.Current_Medication_Type + ' · ' + c.Current_Medication_Name + ' · ' + c.Current_Dosage),
      body: '<div class="form-grid">' + medFields('', { type: c.Current_Medication_Type, name: c.Current_Medication_Name }).map(field).join('') +
        field({ name: 'dosage', label: 'Dosage', required: true, value: c.Current_Dosage, maxlength: 60 }) +
        field({ name: 'note', label: 'Reason / note (mandatory)', type: 'textarea', required: true, full: true }) + '</div>',
      onSubmit: function (d) { d.clientId = p.view.clientId; return api('client.updateMedication', d).then(function () { afterChange('Medication updated'); }); }
    });
  }

  function noteModal(p) {
    formModal({
      title: 'Add note', size: 'md', submitLabel: 'Add note', subtitle: esc(p.view.fullName),
      body: field({ name: 'note', label: 'Note', type: 'textarea', required: true }) + (isAdmin() ? field({ name: 'internal', label: 'Internal admin note (hidden from partner)', type: 'checkbox' }) : ''),
      onSubmit: function (d) { return api('notes.add', { clientId: p.view.clientId, note: d.note, internal: !!d.internal }).then(function () { afterChange('Note added'); }); }
    });
  }

  function doctorNoteModal(p) {
    formModal({
      title: 'Add doctor note', size: 'md', submitLabel: 'Save doctor note', subtitle: esc(p.view.fullName),
      body: field({ name: 'doctorName', label: "Doctor's name", required: true, value: p.client.Doctor_Name, maxlength: 120 }) + field({ name: 'note', label: 'Doctor note', type: 'textarea', required: true }),
      onSubmit: function (d) { d.clientId = p.view.clientId; return api('notes.addDoctor', d).then(function () { afterChange('Doctor note saved'); }); }
    });
  }

  function extendModal(p) {
    var j = p.view.journey, max = 24 - j.months;
    if (max < 1) return toast('This journey is already at the 24-month maximum', 'error');
    var needsDate = !j.nextScheduleId;
    var lastRefill = p.refills.length ? p.refills[p.refills.length - 1].Refill_Date : p.client.Journey_Start_Date;
    var interval = Number(p.client.Refill_Interval_Days || state.meta.defaultRefillIntervalDays);
    var dflt = addDays(lastRefill, interval); if (dflt < todayStr()) dflt = todayStr();
    var monthsOpts = []; for (var i = 1; i <= Math.min(12, max); i++) monthsOpts.push({ value: i, label: i + ' month' + (i > 1 ? 's' : '') + ' → ' + (j.months + i) + '-month journey' });
    formModal({
      title: 'Extend journey', size: 'md', submitLabel: 'Extend journey',
      subtitle: esc(p.view.fullName) + ' · currently ' + j.months + ' months · ends ' + fmtDate(j.endDate),
      body: (j.status === 'Completed' ? '<div class="alert alert-warn">This journey was marked completed. Extending it reopens it as Active; the completion stays in the history.</div>' : '') +
        '<div class="form-grid">' +
        field({ name: 'months', label: 'Extend by', type: 'select', required: true, options: monthsOpts, value: 1 }) +
        field({ name: 'reason', label: 'Reason', type: 'select', required: true, options: ['Client wants to continue', 'Doctor recommendation', 'Weight goal not yet reached', 'Maintenance phase', 'Other'] }) +
        (needsDate ? field({ name: 'nextRefillDate', label: 'Next refill date', type: 'date', required: true, value: dflt, hint: 'All refills of the current journey are done, so the next one is scheduled now' }) : '') +
        field({ name: 'note', label: 'Note (mandatory)', type: 'textarea', required: true, full: true }) + '</div>',
      onSubmit: function (d) {
        d.clientId = p.view.clientId;
        return api('journey.extend', d, { requestId: uuid() }).then(function (r) { afterChange('Journey extended to ' + r.months + ' months · ends ' + fmtDate(r.expectedEndDate)); });
      }
    });
  }

  /* ---------- cohort retention triangle ---------- */
  function cohortCard(r) {
    var head = '<div class="card"><div class="card-head"><h2>Cohort retention triangle</h2></div><div class="card-body stack">' +
      '<p class="muted small" style="margin:0">Read across each row: of clients who started in that month, what % had a completed refill k months later. A cell stays blank until its month starts, shows a dashed “so far” % while that month is running, and a solid final % once it has ended. A rescheduled refill counts in the month it actually happened, and a client who refills twice in one month counts once.' + (isAdmin() ? ' Follows the company filter above.' : '') + '</p>';
    if (!r.years.length) return head + emptyState('No clients yet', '📈') + '</div></div>';
    var cols = ''; for (var k = 1; k <= r.maxMonths; k++) cols += '<th class="num">Month ' + k + '</th>';
    return head + r.years.map(function (y) {
      return '<div><h3 style="margin-bottom:8px">' + esc(y.year) + '</h3><div class="table-wrap"><table class="table cohort"><thead><tr><th>Cohort (first month)</th><th class="num">Users</th>' + cols + '</tr></thead><tbody>' +
        y.rows.map(function (row) {
          return '<tr><td class="strong nowrap">' + monthLabel(row.month).replace(/ (\d\d)$/, ' 20$1') + '</td><td class="num">' + num(row.users) + '</td>' + row.cells.map(function (c) {
            if (c.state === 'future') return '<td class="num muted">—</td>';
            var alpha = 0.12 + (c.pct || 0) / 100 * 0.7;
            var style = 'background:rgba(249,115,22,' + (c.state === 'partial' ? alpha * 0.6 : alpha).toFixed(2) + ');' + (alpha > 0.55 && c.state === 'final' ? 'color:#fff;' : '');
            return '<td class="num cohort-cell ' + c.state + '" style="' + style + '" title="' + c.count + ' of ' + row.users + ' clients">' + c.pct + '%' + (c.state === 'partial' ? '<div class="so-far">so far · ' + c.count + '/' + row.users + '</div>' : '') + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table></div></div>';
    }).join('') + '</div></div>';
  }

  /* ---------- admin-only client actions ---------- */
  function editClientModal(p) {
    var c = p.client;
    formModal({
      title: 'Edit client information', size: 'lg', submitLabel: 'Save changes', subtitle: 'All changes are recorded in the audit log with before/after values.',
      body: section('Client', [
        { name: 'fullName', label: 'Full name', required: true, value: c.Full_Name }, { name: 'phone', label: 'Phone', required: true, value: c.Phone },
        { name: 'externalClientId', label: 'Client ID', required: true, value: c.External_Client_ID }, { name: 'firstBookingRef', label: 'First booking ref', required: true, value: c.First_Booking_Ref },
        { name: 'journeyStartDate', label: 'Journey start date', type: 'date', required: true, value: c.Journey_Start_Date, hint: 'Changes the expected end date; use “Reschedule” to correct refill dates' },
        { name: 'refillIntervalDays', label: 'Refill interval (days)', type: 'number', required: true, value: c.Refill_Interval_Days, min: 7, max: 120 }
      ]) + section('Measurements & prescription', [
        { name: 'heightCm', label: 'Height (cm)', type: 'number', required: true, value: c.Height_Cm, step: '0.1' }, { name: 'weightKg', label: 'Weight (kg)', type: 'number', required: true, value: c.Weight_Kg, step: '0.1' },
        { name: 'bmi', label: 'BMI', type: 'number', required: true, value: c.BMI, step: '0.1' }, { name: 'doctorName', label: 'Doctor', value: c.Doctor_Name },
        { name: 'prescribedDosage', label: 'Prescribed dosage', required: true, value: c.Prescribed_Dosage }, { name: 'startingDosage', label: 'Starting dosage', required: true, value: c.Starting_Dosage },
        { name: 'prescriptionNotes', label: 'Prescription notes', type: 'textarea', full: true, value: c.Prescription_Notes }
      ]) + field({ name: 'reason', label: 'Reason for change (mandatory)', type: 'textarea', required: true }),
      onSubmit: function (d) { d.clientId = c.Client_ID; return api('client.update', d).then(function (r) { afterChange(r.updated ? 'Client updated' : 'No changes to save'); }); }
    });
  }

  function editRefillModal(p, r) {
    if (!r) return;
    formModal({
      title: 'Correct refill #' + r.Cycle_Number, size: 'lg', submitLabel: 'Save correction', subtitle: 'The original values are preserved in the audit log.',
      body: section('Refill', [
        { name: 'refillDate', label: 'Refill date', type: 'date', required: true, value: r.Refill_Date }, { name: 'bookingRef', label: 'Booking ref', required: true, value: r.Booking_Ref },
        { name: 'medicationType', label: 'Medication type', type: 'select', required: true, options: state.meta.medicationTypes, value: r.Medication_Type },
        { name: 'medicationName', label: 'Medication', type: 'select', required: true, options: state.meta.medications, value: r.Medication_Name },
        { name: 'dosage', label: 'Dosage', required: true, value: r.Dosage }, { name: 'quantity', label: 'Quantity', required: true, value: r.Quantity },
        { name: 'doctorName', label: 'Doctor', value: r.Doctor_Name }, { name: 'doctorNotes', label: 'Doctor notes', type: 'textarea', value: r.Doctor_Notes },
        { name: 'partnerNotes', label: 'Partner notes', type: 'textarea', required: true, full: true, value: r.Partner_Notes }
      ]) + section('Payment', [
        { name: 'amountCollected', label: 'Amount (' + currency() + ')', type: 'number', min: 0, step: '0.01', required: true, value: r.Amount_Collected || 0 },
        { name: 'paymentStatus', label: 'Payment status', type: 'select', options: state.meta.paymentStatuses, value: r.Payment_Status },
        { name: 'paymentDate', label: 'Payment date', type: 'date', value: r.Payment_Date }, { name: 'paymentRef', label: 'Payment ref', value: r.Payment_Ref }
      ]) + field({ name: 'reason', label: 'Reason for correction (mandatory)', type: 'textarea', required: true }),
      onSubmit: function (d) { d.refillId = r.Refill_ID; return api('refill.update', d).then(function (x) { afterChange(x.updated ? 'Refill corrected' : 'No changes to save'); }); }
    });
  }

  function editPaymentModal(x, done) {
    if (!x) return;
    formModal({
      title: 'Correct payment', size: 'md', submitLabel: 'Save correction', subtitle: esc(x.Transaction_ID + ' · ' + x.Client_Name),
      body: '<div class="form-grid">' +
        field({ name: 'amount', label: 'Amount (' + x.Currency + ')', type: 'number', min: 0, step: '0.01', required: true, value: x.Amount }) +
        field({ name: 'paymentDate', label: 'Payment collection date', type: 'date', required: true, value: x.Payment_Date }) +
        field({ name: 'paymentStatus', label: 'Payment status', type: 'select', required: true, options: state.meta.paymentStatuses, value: x.Payment_Status }) +
        field({ name: 'paymentRef', label: 'Payment reference', value: x.Payment_Ref }) +
        field({ name: 'reason', label: 'Reason for correction (mandatory)', type: 'textarea', required: true, full: true }) + '</div>',
      onSubmit: function (d) { d.transactionId = x.Transaction_ID; return api('payment.update', d).then(function (r) { if (r.updated) done(); else toast('No changes to save'); }); }
    });
  }

  function journeyStatusModal(p, status) {
    var j = p.view.journey;
    var needsDate = status === 'Active';
    var titles = { Paused: 'Pause journey', Stopped: 'Stop journey', Active: 'Reactivate journey' };
    formModal({
      title: titles[status], size: 'md', submitLabel: titles[status], subtitle: esc(p.view.fullName) + ' · currently ' + esc(j.storedStatus),
      body: (status === 'Stopped' ? '<div class="alert alert-warn">Stopping cancels the open refill. The full history is kept and the journey can be reactivated later.</div>' : '') +
        (status === 'Paused' ? '<div class="alert alert-info">Paused journeys are excluded from overdue reminders until reactivated.</div>' : '') +
        (needsDate ? field({ name: 'nextRefillDate', label: 'Next refill date', type: 'date', required: !j.nextScheduleId, value: j.nextRefillDate || todayStr(), hint: j.nextScheduleId ? 'Leave as is to keep the current schedule' : 'Required – a new refill will be scheduled' }) : '') +
        field({ name: 'reason', label: 'Reason (mandatory)', type: 'textarea', required: true }),
      onSubmit: function (d) {
        var payload = { clientId: p.view.clientId, status: status, reason: d.reason };
        if (needsDate && d.nextRefillDate && d.nextRefillDate !== j.nextRefillDate) payload.nextRefillDate = d.nextRefillDate;
        return api('journey.setStatus', payload, { requestId: uuid() }).then(function () { afterChange('Journey ' + (status === 'Active' ? 'reactivated' : status.toLowerCase())); });
      }
    });
  }

  function completionModal(p) {
    var j = p.view.journey, short = j.milestones < j.months;
    formModal({
      title: 'Confirm journey completion', size: 'md', submitLabel: 'Confirm completion', subtitle: esc(p.view.fullName) + ' · ' + j.milestones + ' of ' + j.months + ' months supplied',
      body: (short ? '<div class="alert alert-warn">Only ' + j.milestones + ' of ' + j.months + ' months are recorded. Completion should only be confirmed after a medical/operational review.</div>' + field({ name: 'override', label: 'I have reviewed the history and confirm completion anyway', type: 'checkbox' }) : '<div class="alert alert-success">All journey months are recorded. Review the full history before confirming.</div>') +
        field({ name: 'note', label: 'Review note (mandatory)', type: 'textarea', required: true, placeholder: 'e.g. Reviewed by Dr. … – outcome, final weight, follow-up' }),
      onSubmit: function (d) { return api('journey.confirmCompletion', { clientId: p.view.clientId, note: d.note, override: !!d.override }).then(function () { afterChange('Journey marked as completed'); }); }
    });
  }

  /* ===========================================================================
   * 10. REFILL BOARD (shared)
   * ========================================================================= */
  function boardItem(it, kind) {
    var when = kind === 'completed' ? 'Refilled ' + fmtDate(it.refillDate) + ' · ' + esc(it.timing)
      : 'Due ' + fmtDate(it.expectedDate) + (it.days < 0 ? ' · <b style="color:var(--red)">' + Math.abs(it.days) + 'd overdue</b>' : (it.days === 0 ? ' · <b>today</b>' : ' · in ' + it.days + 'd'));
    return '<div class="board-item"><div class="top"><div><a href="#" data-action="open-client" data-id="' + esc(it.clientId) + '" class="cell-title">' + esc(it.clientName) + '</a>' +
      '<div class="cell-sub">' + esc(it.externalClientId) + (isAdmin() ? ' · ' + esc(it.companyName) : '') + (it.phone ? ' · ' + esc(it.phone) : '') + '</div></div><span class="count-pill">#' + esc(it.cycle) + '</span></div>' +
      '<div class="small">' + when + (it.rescheduleCount ? ' · ' + badge('rescheduled ' + it.rescheduleCount + '×', 'orange') : '') + '</div>' +
      '<div class="cell-sub">' + esc(it.medicationName) + ' · ' + esc(it.dosage) + (kind === 'completed' && it.amount ? ' · ' + money(it.amount) + ' ' + esc(it.paymentStatus) : '') + '</div>' +
      (kind !== 'completed' ? '<div class="row"><button class="btn btn-sm btn-success" data-action="record-refill" data-id="' + esc(it.clientId) + '">＋ Refill</button><button class="btn btn-sm" data-action="reschedule" data-id="' + esc(it.clientId) + '">📅 Reschedule</button></div>' : '') + '</div>';
  }
  function boardCol(title, cls, items, kind, empty) {
    return '<div class="card board-col ' + cls + '"><div class="card-head"><h2>' + esc(title) + '</h2><span class="count-pill">' + items.length + '</span></div><div class="board-list">' +
      (items.length ? items.map(function (it) { return boardItem(it, kind); }).join('') : emptyState(empty, '✓')) + '</div></div>';
  }
  function renderBoard(b) {
    return '<div class="board">' +
      boardCol('Overdue', 'red', b.overdue, 'open', 'No overdue refills') +
      boardCol('Due today', 'orange', b.today, 'open', 'Nothing due today') +
      boardCol('Due this week', 'orange', b.thisWeek, 'open', 'Nothing else this week') +
      boardCol('Due next week', 'blue', b.nextWeek, 'open', 'Nothing due next week') +
      boardCol('Rescheduled', 'grey', b.rescheduled, 'open', 'No rescheduled refills') +
      boardCol('Completed (last 30 days)', 'green', b.completed, 'completed', 'No refills in the last 30 days') + '</div>';
  }

  function viewRefills(root) {
    var companies = (state.meta.companies || []).map(function (c) { return { value: c.id, label: c.name }; });
    setHeader(isAdmin() ? 'Refills & Reminders' : 'Refills', isAdmin() ? 'All companies' : state.user.companyName,
      isAdmin() ? '<button class="btn" data-action="export" data-dataset="schedules">⬇ <span class="lbl">Export</span></button>' : '');
    root.innerHTML = (isAdmin() ? '<div class="card" id="reminder-panel"><div class="card-body">' + skeleton(1) + '</div></div><div class="card"><div class="card-body"><div class="toolbar">' +
      field({ name: 'companyId', label: 'Company', type: 'select', options: companies, value: state.params.companyId, placeholder: 'All companies' }) + '</div></div></div>' : '') +
      '<div id="board">' + skeleton(6) + '</div>';
    var sel = $('select[name=companyId]', root);
    var load = function () {
      var cid = sel ? sel.value : '';
      api('refills.board', { companyId: cid }).then(function (r) { $('#board').innerHTML = renderBoard(r.buckets); }).catch(function (e) { $('#board').innerHTML = errorBlock(e); });
      if (isAdmin()) loadReminderPanel(cid);
    };
    if (sel) sel.addEventListener('change', load);
    load();
  }

  function loadReminderPanel(cid) {
    api('reminders.overview', { companyId: cid }).then(function (r) {
      var c = r.counts;
      $('#reminder-panel').innerHTML = '<div class="card-head"><h2>Automatic reminders</h2><span class="muted small">Daily trigger · last run ' + fmtDateTime(r.lastRunAt) + ' · emails ' + (r.emailsEnabled ? 'ON' : 'OFF') + '</span><button class="btn btn-sm btn-primary" data-run-reminders>Run reminder check now</button></div>' +
        '<div class="card-body"><div class="kpis">' + kpi('Overdue', num(c.OVERDUE), 'red') + kpi('Due today', num(c.DUE_TODAY), 'orange') + kpi('Due within 3 days', num(c.DUE_3_DAYS), 'orange') + kpi('Due this week', num(c.DUE_THIS_WEEK), 'navy') + '</div></div>' +
        '<div class="card-body flush">' + notificationTable(r.notifications.slice(0, 100)) + '</div>';
      $('[data-run-reminders]').addEventListener('click', function (e) {
        e.target.disabled = true;
        api('reminders.run', {}, { requestId: uuid() }).then(function (x) { toast(x.created + ' new reminder(s) · ' + x.emailed + ' email(s) sent', 'success'); loadReminderPanel(cid); refreshCounts(); })
          .catch(function (er) { toast(er.message, 'error'); e.target.disabled = false; });
      });
    }).catch(function (e) { $('#reminder-panel').innerHTML = '<div class="card-body">' + errorBlock(e) + '</div>'; });
  }

  var CAT = { OVERDUE: ['Overdue', 'overdue'], DUE_TODAY: ['Due today', 'due-today'], DUE_3_DAYS: ['Due within 3 days', 'upcoming'], DUE_THIS_WEEK: ['Due this week', 'active'] };
  function notificationTable(list) {
    if (!list.length) return emptyState('No open reminders', '🔔');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>Category</th><th>Client</th>' + (isAdmin() ? '<th>Company</th>' : '') + '<th>Reminder</th><th>Due</th><th>Created</th></tr></thead><tbody>' +
      list.map(function (n) {
        return '<tr class="clickable" data-action="open-client" data-id="' + esc(n.clientId) + '"' + (n.read ? '' : ' style="font-weight:600"') + '><td>' + badge(CAT[n.category][0], CAT[n.category][1]) + '</td><td>' + esc(n.clientName) + '</td>' + (isAdmin() ? '<td>' + esc(n.companyName) + '</td>' : '') +
          '<td>' + esc(n.message) + '</td><td class="nowrap">' + fmtDate(n.dueDate) + '</td><td class="nowrap">' + fmtDateTime(n.createdAt) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ===========================================================================
   * 11. PARTNER VIEWS
   * ========================================================================= */
  function partnerDashboard(root) {
    setHeader('Dashboard', state.user.companyName + ' · ' + fmtDate(todayStr()), '<button class="btn btn-primary" data-action="register-client">＋ <span class="lbl">Register client</span></button>');
    Promise.all([api('dashboard.summary'), api('refills.board'), api('notifications.list'), api('reports.cohort')]).then(function (r) {
      var s = r[0], b = r[1].buckets, n = r[2].notifications, cohort = r[3];
      root.innerHTML = '<div class="kpis">' +
        kpi('Total registered clients', num(s.totalClients), 'navy', '', 'go-clients') +
        kpi('Active GLP clients', num(s.active), '', s.paused ? s.paused + ' paused' : '', 'go-active') +
        kpi('Completed journeys', num(s.completed), 'green', s.awaitingReview ? s.awaitingReview + ' awaiting review' : '') +
        kpi('Stopped clients', num(s.stopped), 'grey') +
        kpi("Today's refills", num(s.refillsToday), 'orange', '', 'go-refills') +
        kpi('Refills this week', num(s.refillsThisWeek), 'orange', 'Through Sunday', 'go-refills') +
        kpi('Overdue refills', num(s.refillsOverdue), 'red', '', 'go-overdue') +
        kpi('Refills completed', num(s.refillsCompleted), 'green') +
        kpi('Total collected', money(s.collected, s.currency), 'purple', s.pendingAmount ? money(s.pendingAmount, s.currency) + ' pending' : 'Paid transactions only') + '</div>' +
        (n.length ? '<div class="card"><div class="card-head"><h2>🔔 Reminders</h2><span class="muted small">' + s.unreadNotifications + ' unread</span><button class="btn btn-sm" data-action="go" data-view="notifications">View all</button></div><div class="card-body flush">' + notificationTable(n.slice(0, 6)) + '</div></div>' : '') +
        '<div class="board">' + boardCol('Overdue', 'red', b.overdue, 'open', 'No overdue refills 🎉') + boardCol('Due today', 'orange', b.today, 'open', 'Nothing due today') + boardCol('Due this week', 'orange', b.thisWeek, 'open', 'Nothing else this week') + '</div>' + cohortCard(cohort);
      $$('.kpi[data-action]', root).forEach(function (k) {
        var map = { 'go-clients': ['clients', {}], 'go-active': ['clients', { status: 'Active' }], 'go-refills': ['refills', {}], 'go-overdue': ['clients', { status: 'Overdue' }] };
        var t = map[k.getAttribute('data-action')];
        k.setAttribute('data-action', 'go'); k.setAttribute('data-view', t[0]); k.setAttribute('data-params', JSON.stringify(t[1]));
      });
    }).catch(function (e) { root.innerHTML = errorBlock(e); });
  }

  function partnerNotifications(root) {
    setHeader('Reminders', 'Automatic refill reminders for ' + state.user.companyName, '<button class="btn" data-mark-all>✓ <span class="lbl">Mark all as read</span></button>');
    api('notifications.list').then(function (r) {
      var groups = { OVERDUE: [], DUE_TODAY: [], DUE_3_DAYS: [], DUE_THIS_WEEK: [] };
      r.notifications.forEach(function (n) { groups[n.category].push(n); });
      root.innerHTML = '<div class="kpis">' + kpi('Overdue', groups.OVERDUE.length, 'red') + kpi('Due today', groups.DUE_TODAY.length, 'orange') + kpi('Due within 3 days', groups.DUE_3_DAYS.length, 'orange') + kpi('Due this week', groups.DUE_THIS_WEEK.length, 'navy') + '</div>' +
        '<div class="card"><div class="card-head"><h2>Open reminders</h2><span class="muted small">Reminders close automatically when the refill is recorded or rescheduled</span></div><div class="card-body flush">' + notificationTable(r.notifications) + '</div></div>';
      $('[data-mark-all]').onclick = function () { api('notifications.markRead', { all: true }).then(function (x) { toast(x.marked + ' marked as read', 'success'); refreshAll(); }).catch(function (e) { toast(e.message, 'error'); }); };
    }).catch(function (e) { root.innerHTML = errorBlock(e); });
  }

  function partnerAccount(root) {
    var u = state.user;
    setHeader('My account', u.companyName);
    root.innerHTML = '<div class="card" style="max-width:640px"><div class="card-head"><h2>Profile</h2></div><div class="card-body stack">' +
      kv([['Name', u.name], ['Company', u.companyName], ['Email', u.email || '—'], ['Session expires', fmtDateTime(u.expiresAt), 1]]) +
      '<div class="alert alert-info">Your account belongs to ' + esc(u.companyName) + '. You can only see clients registered by your company. Every record you create or update is stored with your name.</div>' +
      '<div class="row"><button class="btn btn-primary" data-action="change-password">Change password</button><button class="btn" data-action="logout">Sign out</button></div></div></div>';
  }

  /* ===========================================================================
   * 12. ADMIN VIEWS
   * ========================================================================= */
  function adminDashboard(root) {
    var p = state.params, t = todayStr();
    var sixAgo = new Date(t.slice(0, 8) + '01T00:00:00Z'); sixAgo.setUTCMonth(sixAgo.getUTCMonth() - 5);
    var def = { from: p.from || sixAgo.toISOString().slice(0, 10), to: p.to || t }; // default: last 6 calendar months
    var companies = (state.meta.companies || []).map(function (c) { return { value: c.id, label: c.name }; });
    setHeader('Performance dashboard', 'Overall and partner-wise performance', '<button class="btn" data-action="export" data-dataset="clients">⬇ <span class="lbl">Export</span></button>');
    root.innerHTML = '<div class="card"><div class="card-body"><form class="toolbar" id="perf-filters">' +
      field({ name: 'from', label: 'From', type: 'date', value: def.from }) + field({ name: 'to', label: 'To', type: 'date', value: def.to }) +
      field({ name: 'companyId', label: 'Company', type: 'select', options: companies, value: p.companyId, placeholder: 'All companies' }) +
      '<div class="chips" style="align-self:center"><button type="button" class="chip" data-range="this_month">This month</button><button type="button" class="chip" data-range="3m">3 months</button><button type="button" class="chip" data-range="6m">6 months</button><button type="button" class="chip" data-range="12m">12 months</button><button type="button" class="chip" data-range="all">All time</button></div>' +
      '</form></div></div><div id="perf">' + skeleton(8) + '</div>';
    var form = $('#perf-filters');
    var load = function () {
      destroyCharts();
      $('#perf').innerHTML = skeleton(8);
      var f = readForm(form);
      Promise.all([api('reports.performance', f), api('client.list', { awaitingReview: true, companyId: f.companyId }), api('reports.cohort', { companyId: f.companyId })]).then(function (r) { renderPerformance(r[0], r[1].clients); $('#perf .stack').insertAdjacentHTML('beforeend', cohortCard(r[2])); })
        .catch(function (e) { $('#perf').innerHTML = errorBlock(e); });
    };
    form.addEventListener('change', load);
    $$('[data-range]', form).forEach(function (b) {
      b.addEventListener('click', function () {
        var r = b.getAttribute('data-range'), to = todayStr(), from;
        if (r === 'this_month') from = to.slice(0, 8) + '01';
        else if (r === 'all') from = '2000-01-01';
        else { var n = parseInt(r, 10); var d = new Date(to.slice(0, 8) + '01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - (n - 1)); from = d.toISOString().slice(0, 10); }
        form.from.value = from; form.to.value = to; load();
      });
    });
    load();
  }

  function renderPerformance(r, review) {
    var k = r.kpi, cur = r.currency;
    var rows = r.partners;
    var tot = function (f) { return rows.reduce(function (s, x) { return s + (x[f] || 0); }, 0); };
    $('#perf').innerHTML = '<div class="stack"><div class="kpis">' +
      kpi('Registered clients', num(k.totalClients), 'navy', 'In selected period') + kpi('Active clients', num(k.active), '', 'Incl. overdue') + kpi('Completed journeys', num(k.completed), 'green') +
      kpi('Stopped clients', num(k.stopped), 'grey') + kpi('Overdue clients', num(k.overdueNow), 'red', 'Right now, all periods') + kpi('Upcoming refills', num(k.upcomingRefillsNow), 'orange', 'Open refills right now') +
      kpi('Completed refills', num(k.refillsCompleted), 'green', 'In period') + kpi('Expected refills', num(k.refillsExpected), 'navy', 'Due in period') +
      kpi('Payments collected', money(k.revenue, cur), 'purple', 'Paid only') + kpi('Upsell revenue', money(k.upsell, cur), 'purple', r.definitions.upsell) +
      kpi('Client retention', pct(k.retentionPct), 'green', 'Not stopped ÷ started') + kpi('Refill completion', pct(k.refillCompletionPct), '', 'Completed ÷ due to date') +
      kpi('Conversion', pct(k.conversionPct), 'navy', r.definitions.conversion) + '</div>' +
      '<div class="card"><div class="card-head"><h2>Partner-wise performance</h2><span class="muted small">' + (r.from ? fmtDate(r.from) : 'All time') + ' → ' + fmtDate(r.to) + '</span></div><div class="card-body flush"><div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>Partner</th><th class="num">New clients</th><th class="num">Active</th><th class="num">Completed</th><th class="num">Stopped</th><th class="num">Refills due</th><th class="num">Refills completed</th><th class="num">Overdue</th><th class="num">Retention</th><th class="num">Conversion</th><th class="num">Revenue</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (x) {
        return '<tr class="clickable" data-action="go" data-view="clients" data-params="' + esc(JSON.stringify({ companyId: x.companyId })) + '"><td class="strong">' + esc(x.companyName) + (x.status !== 'Active' ? ' ' + badge('Inactive', 'grey') : '') + '</td><td class="num">' + num(x.newClients) + '</td><td class="num">' + num(x.active) + '</td><td class="num">' + num(x.completed) + '</td><td class="num">' + num(x.stopped) + '</td>' +
          '<td class="num">' + num(x.refillsDue) + '</td><td class="num">' + num(x.refillsCompleted) + '</td><td class="num">' + (x.overdue ? '<b style="color:var(--red)">' + num(x.overdue) + '</b>' : 0) + '</td><td class="num">' + pct(x.retentionPct) + '</td><td class="num">' + pct(x.conversionPct) + '</td><td class="num strong">' + money(x.revenue, cur) + '</td></tr>';
      }).join('') : '<tr><td colspan="11">' + emptyState('No partner companies yet') + '</td></tr>') +
      '</tbody>' + (rows.length > 1 ? '<tfoot><tr><td>Total</td><td class="num">' + num(tot('newClients')) + '</td><td class="num">' + num(tot('active')) + '</td><td class="num">' + num(tot('completed')) + '</td><td class="num">' + num(tot('stopped')) + '</td><td class="num">' + num(tot('refillsDue')) + '</td><td class="num">' + num(tot('refillsCompleted')) + '</td><td class="num">' + num(tot('overdue')) + '</td><td class="num">' + pct(k.retentionPct) + '</td><td class="num">' + pct(k.conversionPct) + '</td><td class="num">' + money(k.revenue, cur) + '</td></tr></tfoot>' : '') +
      '</table></div></div></div>' +
      '<div class="grid-2">' + chartBox('ch-reg', 'New client registrations by partner') + chartBox('ch-refill', 'Monthly refill performance', 'Due vs completed') + '</div>' +
      '<div class="grid-2">' + chartBox('ch-rev', 'Partner-wise revenue', 'Paid only') + chartBox('ch-conv', 'Partner-wise conversion', r.definitions.conversion) + '</div>' +
      '<div class="grid-3">' + chartBox('ch-ret', 'Client retention by partner') + chartBox('ch-over', 'Overdue refills by partner') + chartBox('ch-ups', 'Monthly upsell performance') + '</div>' +
      '<div class="card"><div class="card-head"><h2>Journeys awaiting completion review</h2><span class="count-pill">' + review.length + '</span></div><div class="card-body flush">' + clientsTable(review, { emptyText: 'No journeys awaiting review' }) + '</div></div>' +
      '<div class="card"><div class="card-head"><h2>Metric definitions</h2><a href="#/settings" class="small">Configure</a></div><div class="card-body">' +
      kv([['Conversion', r.definitions.conversion], ['Conversion denominator', r.definitions.conversionDenominator], ['Retention', r.definitions.retention], ['Refill completion', r.definitions.refillCompletion], ['Upsell revenue', r.definitions.upsell]]) + '</div></div></div>';
    var names = rows.map(function (x) { return x.companyName; });
    makeChart('ch-reg', 'bar', names, [{ label: 'New clients', data: rows.map(function (x) { return x.newClients; }), color: PALETTE[1] }]);
    makeChart('ch-refill', 'bar', r.monthly.map(function (m) { return monthLabel(m.month); }), [{ label: 'Due', data: r.monthly.map(function (m) { return m.due; }), color: PALETTE[2] }, { label: 'Completed', data: r.monthly.map(function (m) { return m.completed; }), color: PALETTE[3] }]);
    makeChart('ch-rev', 'bar', names, [{ label: 'Revenue', data: rows.map(function (x) { return x.revenue; }), color: PALETTE[0] }, { label: 'Upsell', data: rows.map(function (x) { return x.upsell; }), color: PALETTE[5] }], { money: true });
    makeChart('ch-conv', 'bar', names, [{ label: 'Conversion %', data: rows.map(function (x) { return x.conversionPct || 0; }), color: PALETTE[1] }], { pct: true });
    makeChart('ch-ret', 'bar', names, [{ label: 'Retention %', data: rows.map(function (x) { return x.retentionPct || 0; }), color: PALETTE[3] }], { pct: true });
    makeChart('ch-over', 'bar', names, [{ label: 'Overdue clients', data: rows.map(function (x) { return x.overdue; }), color: PALETTE[6] }]);
    makeChart('ch-ups', 'line', r.monthly.map(function (m) { return monthLabel(m.month); }), [{ label: 'Upsell', data: r.monthly.map(function (m) { return m.upsell; }), color: PALETTE[5] }, { label: 'All revenue', data: r.monthly.map(function (m) { return m.revenue; }), color: PALETTE[0], fill: false }], { money: true });
  }

  /* ---------- Upsell & payment tracker ---------- */
  function adminPayments(root) {
    var m = state.meta, p = state.params;
    var companies = (m.companies || []).map(function (c) { return { value: c.id, label: c.name }; });
    var users = (m.partnerUsers || []).map(function (u) { var co = (m.companies || []).filter(function (c) { return c.id === u.companyId; })[0]; return { value: u.id, label: u.name + (co ? ' (' + co.name + ')' : '') }; });
    var preset = p.preset || 'this_month';
    setHeader('Upsell & payment tracker', 'Every registration and refill payment is captured automatically', '<button class="btn" data-export-table>⬇ <span class="lbl">Export table</span></button>');
    root.innerHTML = '<div class="card"><div class="card-body stack"><div class="chips" id="presets">' +
      [['today', 'Today'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom range'], ['all', 'All time']].map(function (x) { return '<button type="button" class="chip ' + (preset === x[0] ? 'active' : '') + '" data-preset="' + x[0] + '">' + x[1] + '</button>'; }).join('') +
      '</div><form class="toolbar" id="pay-filters">' +
      field({ name: 'from', label: 'From', type: 'date', value: p.from }) + field({ name: 'to', label: 'To', type: 'date', value: p.to }) +
      field({ name: 'companyId', label: 'Company', type: 'select', options: companies, placeholder: 'All companies', value: p.companyId }) +
      field({ name: 'createdBy', label: 'Partner user', type: 'select', options: users, placeholder: 'All partner users' }) +
      field({ name: 'medicationName', label: 'Medication', type: 'select', options: m.medications, placeholder: 'All medications' }) +
      field({ name: 'medicationType', label: 'Injection / pills', type: 'select', options: m.medicationTypes, placeholder: 'All' }) +
      field({ name: 'transactionType', label: 'Transaction type', type: 'select', options: ['Registration', 'Refill'], placeholder: 'All types' }) +
      field({ name: 'paymentStatus', label: 'Payment status', type: 'select', options: m.paymentStatuses, placeholder: 'All statuses' }) +
      '</form></div></div><div id="pay">' + skeleton(6) + '</div>';
    var form = $('#pay-filters'), last = null;
    var toggleDates = function () { var custom = preset === 'custom'; form.from.disabled = !custom; form.to.disabled = !custom; };
    var load = function () {
      destroyCharts(); toggleDates();
      var f = readForm(form); f.preset = preset;
      if (preset === 'custom' && (!f.from || !f.to)) { $('#pay').innerHTML = '<div class="alert alert-info">Choose a from and to date for the custom range.</div>'; return; }
      api('reports.upsell', f).then(function (r) { last = r; form.from.value = r.from; form.to.value = r.to; renderPayments(r); }).catch(function (e) { $('#pay').innerHTML = errorBlock(e); });
    };
    $$('[data-preset]').forEach(function (b) { b.addEventListener('click', function () { preset = b.getAttribute('data-preset'); $$('[data-preset]').forEach(function (x) { x.classList.toggle('active', x === b); }); load(); }); });
    form.addEventListener('change', load);
    $('[data-export-table]').addEventListener('click', function () { if (last) exportRows(last.transactions, 'glp1-payments-' + (last.from || 'all') + '-' + last.to, 'xlsx'); });
    load();
  }

  function renderPayments(r) {
    var t = r.totals, cur = r.currency;
    $('#pay').innerHTML = '<div class="stack"><div class="kpis">' +
      kpi('Total amount collected', money(t.amount, cur), 'purple', 'Paid transactions only') + kpi('Number of transactions', num(t.transactions), 'navy', t.allTransactions - t.transactions ? (t.allTransactions - t.transactions) + ' not paid (excluded)' : '') +
      kpi('Number of clients', num(t.clients)) + kpi('Average collection', money(t.average, cur), 'green') + kpi('Upsell revenue', money(t.upsell, cur), 'purple') + kpi('Pending (not counted)', money(t.pendingAmount, cur), 'orange') + '</div>' +
      '<div class="grid-2">' + chartBox('ch-pc', 'Partner-wise collection') + chartBox('ch-daily', 'Daily collection trend') + '</div>' +
      '<div class="grid-2">' + chartBox('ch-weekly', 'Weekly collection trend', 'Week starting Monday') + chartBox('ch-monthly', 'Monthly collection trend') + '</div>' +
      '<div class="grid-2"><div class="card"><div class="card-head"><h2>By company</h2></div><div class="card-body flush">' + simpleTable(['Company', 'Transactions', 'Collected', 'Upsell'], r.byCompany.map(function (x) { return [esc(x.companyName), num(x.count), money(x.amount, cur), money(x.upsell, cur)]; })) + '</div></div>' +
      '<div class="card"><div class="card-head"><h2>By partner user</h2></div><div class="card-body flush">' + simpleTable(['Partner user', 'Company', 'Transactions', 'Collected'], r.byUser.map(function (x) { return [esc(x.name), esc(x.companyName), num(x.count), money(x.amount, cur)]; })) + '</div></div></div>' +
      '<div class="card"><div class="card-head"><h2>Payment transactions</h2><span class="muted small">' + r.transactions.length + ' records · ' + (r.from ? fmtDate(r.from) + ' → ' + fmtDate(r.to) : 'All time') + '</span></div><div class="card-body flush">' +
      (r.transactions.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Transaction</th><th>Client</th><th>Company</th><th>Source ref</th><th>Type</th><th>Medication</th><th class="num">Amount</th><th>Payment date</th><th>Status</th><th>Created by</th><th></th></tr></thead><tbody>' +
        r.transactions.map(function (x) {
          return '<tr><td class="mono">' + esc(x.Transaction_ID) + '</td><td><a href="#" data-action="open-client" data-id="' + esc(x.Client_ID) + '" class="cell-title">' + esc(x.Client_Name) + '</a><div class="cell-sub">' + esc(x.External_Client_ID) + '</div></td><td>' + esc(x.Company_Name) + '</td>' +
            '<td>' + esc(x.Booking_Ref) + '<div class="cell-sub">' + esc(x.Source_Type) + '</div></td><td>' + esc(x.Transaction_Type) + '</td><td>' + esc(x.Medication_Name) + '<div class="cell-sub">' + esc(x.Medication_Type) + '</div></td>' +
            '<td class="num strong">' + money(x.Amount, x.Currency) + '</td><td class="nowrap">' + fmtDate(x.Payment_Date) + '</td><td>' + badge(x.Payment_Status) + '</td><td>' + esc(x.Created_By_Name) + '<div class="cell-sub">' + fmtDateTime(x.Created_At) + '</div></td>' +
            '<td><button class="btn btn-sm" data-fix-tx="' + esc(x.Transaction_ID) + '">Correct</button></td></tr>';
        }).join('') + '</tbody></table></div>' : emptyState('No payments in this period', '💳')) + '</div></div></div>';
    makeChart('ch-pc', 'bar', r.byCompany.map(function (x) { return x.companyName; }), [{ label: 'Collected', data: r.byCompany.map(function (x) { return x.amount; }), color: PALETTE[0] }, { label: 'Upsell', data: r.byCompany.map(function (x) { return x.upsell; }), color: PALETTE[5] }], { money: true });
    makeChart('ch-daily', 'line', r.daily.map(function (x) { return fmtDate(x.key).slice(0, 6); }), [{ label: 'Collected', data: r.daily.map(function (x) { return x.amount; }), color: PALETTE[1] }], { money: true });
    makeChart('ch-weekly', 'bar', r.weekly.map(function (x) { return fmtDate(x.key).slice(0, 6); }), [{ label: 'Collected', data: r.weekly.map(function (x) { return x.amount; }), color: PALETTE[1] }], { money: true });
    makeChart('ch-monthly', 'bar', r.monthly.map(function (x) { return monthLabel(x.key); }), [{ label: 'Collected', data: r.monthly.map(function (x) { return x.amount; }), color: PALETTE[0] }], { money: true });
    $$('[data-fix-tx]').forEach(function (b) {
      b.addEventListener('click', function () {
        var tx = r.transactions.filter(function (x) { return x.Transaction_ID === b.getAttribute('data-fix-tx'); })[0];
        editPaymentModal(tx, function () { toast('Payment corrected', 'success'); state.refresh(); });
      });
    });
  }
  function simpleTable(head, rows) {
    if (!rows.length) return emptyState('No data');
    return '<div class="table-wrap"><table class="table"><thead><tr>' + head.map(function (h, i) { return '<th' + (i > 0 ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i > 0 && typeof c === 'string' && /^[A-Z]{3} |^[\d,]+$/.test(c) ? ' class="num"' : '') + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }

  /* ---------- Upsell creation worklist ---------- */
  function adminUpsell(root) {
    var companies = (state.meta.companies || []).map(function (c) { return { value: c.id, label: c.name }; });
    var preset = 'all', tab = state.params.tab === 'refills' ? 'refills' : 'registrations', data = null, selected = {};
    setHeader('Upsell creation', 'New registrations and refills to create as upsells');
    root.innerHTML = '<div class="card"><div class="card-body stack"><div class="chips" id="up-presets">' +
      [['all', 'All time'], ['today', 'Today'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom range']].map(function (x) { return '<button type="button" class="chip ' + (x[0] === preset ? 'active' : '') + '" data-preset="' + x[0] + '">' + x[1] + '</button>'; }).join('') +
      '</div><form class="toolbar" id="up-filters">' + field({ name: 'from', label: 'From', type: 'date' }) + field({ name: 'to', label: 'To', type: 'date' }) +
      field({ name: 'companyId', label: 'Company', type: 'select', options: companies, placeholder: 'All companies' }) +
      field({ name: 'upsellStatus', label: 'Upsell status', type: 'select', options: [{ value: 'Pending', label: 'Pending upsell' }, { value: 'Created', label: 'Upsell created' }], value: 'Pending', placeholder: 'All' }) +
      '</form></div></div><div id="up-body">' + skeleton(4) + '</div>';
    var form = $('#up-filters');
    var load = function () {
      form.from.disabled = form.to.disabled = preset !== 'custom';
      var f = readForm(form); f.preset = preset;
      if (preset === 'custom' && (!f.from || !f.to)) { $('#up-body').innerHTML = '<div class="alert alert-info">Choose a from and to date.</div>'; return; }
      api('upsell.list', f).then(function (r) { data = r; selected = {}; form.from.value = r.from; form.to.value = r.to; render(); }).catch(function (e) { $('#up-body').innerHTML = errorBlock(e); });
    };
    var list = function () { return tab === 'refills' ? data.refills : data.registrations; };
    var type = function () { return tab === 'refills' ? 'refill' : 'registration'; };
    var exportRowsFor = function (rows) {
      return rows.map(function (x) {
        var o = { 'Ref ID': x.bookingRef, 'Client name': x.name, 'Client ID': x.externalClientId, 'Phone': x.phone, 'Company': x.companyName };
        if (x.type === 'registration') { o['Start date'] = x.startDate; o['Registration date'] = x.registrationDate; }
        else { o['Refill #'] = x.cycle; o['Refill date'] = x.refillDate; }
        o['Medication'] = x.medication; o['Amount (' + data.currency + ')'] = x.amount; o['Payment status'] = x.paymentStatus; o['Upsell status'] = x.upsellStatus;
        return o;
      });
    };
    var mark = function (ids, status) {
      if (!ids.length) return toast('Select at least one row', 'error');
      return api('upsell.mark', { type: type(), ids: ids, status: status }, { requestId: uuid() })
        .then(function (r) { toast(r.updated + ' row(s) marked as ' + (status === 'Created' ? 'upsell created' : 'pending'), 'success'); load(); refreshCounts(); })
        .catch(function (e) { toast(e.message, 'error'); });
    };
    function render() {
      var c = data.counts, rows = list(), cur = data.currency, isReg = tab === 'registrations';
      var selCount = Object.keys(selected).length;
      $('#up-body').innerHTML = '<div class="stack"><div class="kpis">' +
        kpi('New clients registered', num(c.registrations.total), 'navy', money(c.registrations.amount, cur) + ' collected (paid)') +
        kpi('Registrations – pending upsell', num(c.registrations.pending), 'orange') + kpi('Registrations – upsell created', num(c.registrations.created), 'green') +
        kpi('Refills', num(c.refills.total), 'navy', money(c.refills.amount, cur) + ' collected (paid)') +
        kpi('Refills – pending upsell', num(c.refills.pending), 'orange') + kpi('Refills – upsell created', num(c.refills.created), 'green') + '</div>' +
        '<div class="card"><div class="tabs" style="padding:0 12px"><button class="tab ' + (isReg ? 'active' : '') + '" data-uptab="registrations">New registrations (' + data.registrations.length + ')</button><button class="tab ' + (!isReg ? 'active' : '') + '" data-uptab="refills">Refills (' + data.refills.length + ')</button></div>' +
        '<div class="card-head"><span class="muted small grow">' + (data.from ? fmtDate(data.from) + ' → ' + fmtDate(data.to) : 'All time') + ' · ' + rows.length + ' rows · ' + selCount + ' selected</span>' +
        '<button class="btn btn-sm" data-up-download>⬇ Download ' + (selCount ? 'selected' : 'list') + ' (Excel)</button>' +
        '<button class="btn btn-sm btn-success" data-up-mark="Created">✓ Mark ' + (selCount ? 'selected' : 'all shown') + ' as upsell created</button>' +
        '<button class="btn btn-sm" data-up-mark="Pending">↺ Mark ' + (selCount ? 'selected' : 'all shown') + ' as pending</button></div>' +
        '<div class="card-body flush">' + (rows.length ? '<div class="table-wrap"><table class="table"><thead><tr><th><input type="checkbox" data-up-all aria-label="Select all"' + (selCount && selCount === rows.length ? ' checked' : '') + '></th>' +
          '<th>Ref ID</th><th>Client</th><th>Company</th>' + (isReg ? '<th>Start date</th><th>Registered</th>' : '<th>Refill #</th><th>Refill date</th>') + '<th>Medication</th><th class="num">Amount</th><th>Payment</th><th>Upsell</th><th></th></tr></thead><tbody>' +
          rows.map(function (x) {
            return '<tr><td><input type="checkbox" data-up-row="' + esc(x.id) + '"' + (selected[x.id] ? ' checked' : '') + ' aria-label="Select"></td><td class="mono strong">' + esc(x.bookingRef) + '</td>' +
              '<td><div class="cell-title">' + esc(x.name) + '</div><div class="cell-sub">' + esc(x.externalClientId) + ' · ' + esc(x.phone) + '</div></td><td>' + esc(x.companyName) + '</td>' +
              (isReg ? '<td class="nowrap">' + fmtDate(x.startDate) + '</td><td class="nowrap">' + fmtDate(x.registrationDate) + '</td>' : '<td>#' + esc(x.cycle) + '</td><td class="nowrap">' + fmtDate(x.refillDate) + '</td>') +
              '<td>' + esc(x.medication) + '</td><td class="num strong">' + money(x.amount, cur) + '</td><td>' + (x.paymentStatus ? badge(x.paymentStatus) : '—') + '</td>' +
              '<td>' + (x.upsellStatus === 'Created' ? badge('Created', 'green') + '<div class="cell-sub">' + fmtDateTime(x.upsellUpdatedAt) + '</div>' : badge('Pending', 'orange')) + '</td>' +
              '<td><button class="btn btn-sm" data-up-one="' + esc(x.id) + '" data-to="' + (x.upsellStatus === 'Created' ? 'Pending' : 'Created') + '">' + (x.upsellStatus === 'Created' ? 'Undo' : '✓ Created') + '</button></td></tr>';
          }).join('') + '</tbody></table></div>' : emptyState('No ' + (isReg ? 'registrations' : 'refills') + ' for these filters', '🧾')) + '</div></div></div>';
      $$('[data-uptab]').forEach(function (b) { b.onclick = function () { tab = b.getAttribute('data-uptab'); selected = {}; render(); }; });
      $$('[data-up-row]').forEach(function (cb) { cb.onchange = function () { var id = cb.getAttribute('data-up-row'); if (cb.checked) selected[id] = 1; else delete selected[id]; render(); }; });
      var all = $('[data-up-all]'); if (all) all.onchange = function () { selected = {}; if (all.checked) rows.forEach(function (x) { selected[x.id] = 1; }); render(); };
      $$('[data-up-one]').forEach(function (b) { b.onclick = function () { mark([b.getAttribute('data-up-one')], b.getAttribute('data-to')); }; });
      var targetIds = function () { var s = Object.keys(selected); return s.length ? s : rows.map(function (x) { return x.id; }); };
      $$('[data-up-mark]').forEach(function (b) {
        b.onclick = function () {
          var ids = targetIds(), to = b.getAttribute('data-up-mark');
          confirmBox({ title: 'Mark ' + ids.length + ' row(s) as ' + (to === 'Created' ? 'upsell created' : 'pending') + '?', message: 'This updates the ' + (isReg ? 'registration' : 'refill') + ' records and is recorded in the audit log.', confirmLabel: 'Mark ' + ids.length })
            .then(function (ok) { if (ok) mark(ids, to); });
        };
      });
      $('[data-up-download]').onclick = function () {
        var ids = targetIds(), set = {}; ids.forEach(function (i) { set[i] = 1; });
        var picked = rows.filter(function (x) { return set[x.id]; });
        if (!picked.length) return toast('Nothing to download', 'error');
        exportRows(exportRowsFor(picked), 'upsell-' + tab + '-' + (data.from || 'all') + '-' + data.to, 'xlsx');
        var pend = picked.filter(function (x) { return x.upsellStatus === 'Pending'; }).map(function (x) { return x.id; });
        if (pend.length) confirmBox({ title: 'Mark downloaded rows as upsell created?', message: pend.length + ' of the downloaded rows are still pending. Mark them as upsell created now?', confirmLabel: 'Yes, mark ' + pend.length + ' as created' })
          .then(function (ok) { if (ok) mark(pend, 'Created'); });
      };
    }
    $$('[data-preset]', root).forEach(function (b) { b.addEventListener('click', function () { preset = b.getAttribute('data-preset'); $$('[data-preset]', root).forEach(function (x) { x.classList.toggle('active', x === b); }); load(); }); });
    form.addEventListener('change', load);
    load();
  }

  /* ---------- Companies & partner users ---------- */
  function adminCompanies(root) {
    setHeader('Companies & partners', 'Partner companies and their login accounts', '<button class="btn btn-primary" data-add-company>＋ <span class="lbl">Add company</span></button>');
    Promise.all([api('company.list'), api('partnerUser.list')]).then(function (r) {
      var cos = r[0].companies, users = r[1].users;
      root.innerHTML = '<div class="card"><div class="card-head"><h2>Partner companies</h2><span class="count-pill">' + cos.length + '</span></div><div class="card-body flush">' +
        (cos.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Company</th><th>Contact</th><th>Status</th><th class="num">Users</th><th class="num">Clients</th><th>Created</th><th></th></tr></thead><tbody>' +
          cos.map(function (c) {
            return '<tr><td><div class="cell-title">' + esc(c.Company_Name) + '</div><div class="cell-sub mono">' + esc(c.Company_ID) + '</div></td><td>' + esc(c.Contact_Name || '—') + '<div class="cell-sub">' + esc([c.Contact_Email, c.Contact_Phone].filter(String).join(' · ')) + '</div></td>' +
              '<td>' + badge(c.Status, c.Status === 'Active' ? 'green' : 'grey') + '</td><td class="num">' + c.activeUserCount + ' / ' + c.userCount + '</td><td class="num">' + c.clientCount + '</td><td class="nowrap">' + fmtDate(c.Created_At) + '</td>' +
              '<td class="nowrap"><button class="btn btn-sm" data-users="' + esc(c.Company_ID) + '">👤 Users</button> <button class="btn btn-sm" data-edit-co="' + esc(c.Company_ID) + '">Edit</button> ' +
              '<button class="btn btn-sm ' + (c.Status === 'Active' ? 'btn-danger' : 'btn-success') + '" data-co-status="' + esc(c.Company_ID) + '">' + (c.Status === 'Active' ? 'Deactivate' : 'Activate') + '</button></td></tr>';
          }).join('') + '</tbody></table></div>' : emptyState('No partner companies yet – add your first one.', '🏥')) + '</div></div>' +
        '<div class="card"><div class="card-head"><h2>All partner users</h2><span class="count-pill">' + users.length + '</span></div><div class="card-body flush">' + partnerUserTable(users, true) + '</div></div>';
      $('[data-add-company]').onclick = function () { companyModal(null); };
      $$('[data-edit-co]').forEach(function (b) { b.onclick = function () { companyModal(cos.filter(function (c) { return c.Company_ID === b.getAttribute('data-edit-co'); })[0]); }; });
      $$('[data-users]').forEach(function (b) { b.onclick = function () { companyUsersModal(cos.filter(function (c) { return c.Company_ID === b.getAttribute('data-users'); })[0]); }; });
      $$('[data-co-status]').forEach(function (b) {
        b.onclick = function () {
          var c = cos.filter(function (x) { return x.Company_ID === b.getAttribute('data-co-status'); })[0], to = c.Status === 'Active' ? 'Inactive' : 'Active';
          confirmBox({ title: (to === 'Active' ? 'Activate ' : 'Deactivate ') + c.Company_Name, message: to === 'Inactive' ? 'All users of this company will be signed out and blocked. Their data is kept.' : 'Users of this company will be able to sign in again.', danger: to === 'Inactive', confirmLabel: to === 'Active' ? 'Activate' : 'Deactivate', reason: true })
            .then(function (reason) { if (!reason) return; return api('company.setStatus', { companyId: c.Company_ID, status: to, reason: reason }).then(function () { toast('Company ' + (to === 'Active' ? 'activated' : 'deactivated'), 'success'); reloadMeta(); state.refresh(); }); })
            .catch(function (e) { toast(e.message, 'error'); });
        };
      });
      bindPartnerUserActions(root, users, function () { state.refresh(); });
    }).catch(function (e) { root.innerHTML = errorBlock(e); });
  }
  function reloadMeta() { return api('meta.options').then(function (m) { state.meta = m; }).catch(function () {}); }

  function partnerUserTable(users, showCompany) {
    if (!users.length) return emptyState('No partner users yet', '👤');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Username</th>' + (showCompany ? '<th>Company</th>' : '') + '<th>Status</th><th>Last login</th><th></th></tr></thead><tbody>' +
      users.map(function (u) {
        var locked = u.Locked_Until && u.Locked_Until > new Date().toISOString();
        return '<tr><td><div class="cell-title">' + esc(u.Full_Name) + '</div><div class="cell-sub">' + esc([u.Email, u.Phone].filter(String).join(' · ') || '—') + '</div></td><td class="mono">' + esc(u.Username) + '</td>' + (showCompany ? '<td>' + esc(u.Company_Name) + '</td>' : '') +
          '<td>' + badge(u.Status, u.Status === 'Active' ? 'green' : 'grey') + (u.Must_Change_Password === 'TRUE' ? ' ' + badge('Temp password', 'orange') : '') + (locked ? ' ' + badge('Locked', 'red') : '') + '</td>' +
          '<td class="nowrap">' + fmtDateTime(u.Last_Login_At) + '</td><td class="nowrap"><button class="btn btn-sm" data-pu-edit="' + esc(u.User_ID) + '">Edit</button> <button class="btn btn-sm" data-pu-reset="' + esc(u.User_ID) + '">Reset password</button> ' +
          '<button class="btn btn-sm ' + (u.Status === 'Active' ? 'btn-danger' : 'btn-success') + '" data-pu-status="' + esc(u.User_ID) + '">' + (u.Status === 'Active' ? 'Deactivate' : 'Activate') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function bindPartnerUserActions(root, users, done) {
    var find = function (id) { return users.filter(function (u) { return u.User_ID === id; })[0]; };
    $$('[data-pu-edit]', root).forEach(function (b) { b.onclick = function () { partnerUserModal(null, find(b.getAttribute('data-pu-edit')), done); }; });
    $$('[data-pu-reset]', root).forEach(function (b) {
      b.onclick = function () {
        var u = find(b.getAttribute('data-pu-reset'));
        confirmBox({ title: 'Reset password for ' + u.Full_Name, message: 'A new temporary password will be generated. The user must change it at next sign-in. Their account will also be unlocked.', confirmLabel: 'Generate new password' })
          .then(function (ok) { if (!ok) return; return api('partnerUser.resetPassword', { userId: u.User_ID }).then(function (r) { showTempPassword(r.username, r.temporaryPassword); done(); }); })
          .catch(function (e) { toast(e.message, 'error'); });
      };
    });
    $$('[data-pu-status]', root).forEach(function (b) {
      b.onclick = function () {
        var u = find(b.getAttribute('data-pu-status')), to = u.Status === 'Active' ? 'Inactive' : 'Active';
        confirmBox({ title: (to === 'Active' ? 'Activate ' : 'Deactivate ') + u.Full_Name, message: to === 'Inactive' ? 'The user is signed out immediately and cannot sign in. Records they created are kept.' : 'The user will be able to sign in again.', danger: to === 'Inactive', confirmLabel: to === 'Active' ? 'Activate' : 'Deactivate' })
          .then(function (ok) { if (!ok) return; return api('partnerUser.setStatus', { userId: u.User_ID, status: to }).then(function () { toast('User ' + (to === 'Active' ? 'activated' : 'deactivated'), 'success'); done(); }); })
          .catch(function (e) { toast(e.message, 'error'); });
      };
    });
  }
  function showTempPassword(username, pw) {
    var m = modal({
      title: 'Share these credentials securely', size: 'sm', persistent: true,
      body: '<p>Username</p><div class="secret-box"><span>' + esc(username) + '</span></div><p>Temporary password</p><div class="secret-box"><span>' + esc(pw) + '</span><button class="btn btn-sm" data-copy>Copy</button></div>' +
        '<div class="alert alert-warn">This password is shown only once and is stored only as a secure hash. Send it through a private channel; the user must set a new password at first sign-in.</div>',
      footer: '<button class="btn btn-primary" data-close>Done</button>'
    });
    $('[data-copy]', m.el).onclick = function () { if (navigator.clipboard) navigator.clipboard.writeText(pw).then(function () { toast('Copied', 'success'); }); };
  }
  function companyModal(c) {
    c = c || {};
    formModal({
      title: c.Company_ID ? 'Edit company' : 'Add partner company', size: 'md', submitLabel: c.Company_ID ? 'Save' : 'Create company',
      body: '<div class="form-grid">' + [
        { name: 'companyName', label: 'Company name', required: true, value: c.Company_Name, full: true, maxlength: 120 }, { name: 'contactName', label: 'Contact person', value: c.Contact_Name },
        { name: 'contactPhone', label: 'Contact phone', value: c.Contact_Phone, type: 'tel' }, { name: 'contactEmail', label: 'Contact email', type: 'email', value: c.Contact_Email, full: true },
        { name: 'address', label: 'Address', value: c.Address, full: true }, { name: 'notes', label: 'Notes', type: 'textarea', value: c.Notes, full: true }].map(field).join('') + '</div>',
      onSubmit: function (d) {
        d.companyId = c.Company_ID || '';
        return api('company.save', d).then(function (r) {
          toast(c.Company_ID ? 'Company updated' : 'Company created', 'success');
          reloadMeta().then(function () { state.refresh(); if (!c.Company_ID) partnerUserModal(r.companyId, null, function () { state.refresh(); }); });
        });
      }
    });
  }
  function companyUsersModal(c) {
    var m = modal({ title: c.Company_Name + ' – users', size: 'lg', body: skeleton(2), footer: '<button class="btn" data-close>Close</button><button class="btn btn-primary" data-add-user>＋ Add user</button>', noAutofocus: true });
    var load = function () {
      api('partnerUser.list', { companyId: c.Company_ID }).then(function (r) {
        m.body('<p class="muted">Each person gets their own login. Every record they create is stored with their name.</p>' + partnerUserTable(r.users, false));
        bindPartnerUserActions(m.el, r.users, function () { load(); state.refresh(); });
      }).catch(function (e) { m.body(errorBlock(e)); });
    };
    $('[data-add-user]', m.el).onclick = function () { partnerUserModal(c.Company_ID, null, function () { load(); state.refresh(); }); };
    load();
  }
  function partnerUserModal(companyId, u, done) {
    u = u || {};
    var companies = (state.meta.companies || []).map(function (c) { return { value: c.id, label: c.name }; });
    formModal({
      title: u.User_ID ? 'Edit partner user' : 'Create partner login', size: 'md', submitLabel: u.User_ID ? 'Save' : 'Create login',
      body: '<div class="form-grid">' +
        (u.User_ID ? field({ name: 'username', label: 'Username', value: u.Username, readonly: true }) + field({ name: 'co', label: 'Company', value: u.Company_Name, readonly: true })
          : field({ name: 'companyId', label: 'Company', type: 'select', required: true, options: companies, value: companyId, full: true }) +
            field({ name: 'username', label: 'Username', required: true, hint: '4–40 chars: letters, numbers, . _ -', attrs: ' autocapitalize="none" spellcheck="false"' }) +
            field({ name: 'password', label: 'Initial password (optional)', type: 'text', hint: 'Leave empty to generate a secure temporary password', attrs: ' autocomplete="off"' })) +
        field({ name: 'fullName', label: 'Full name', required: true, value: u.Full_Name }) + field({ name: 'email', label: 'Email (for reminders)', type: 'email', value: u.Email }) +
        field({ name: 'phone', label: 'Phone', type: 'tel', value: u.Phone }) + '</div>',
      onSubmit: function (d) {
        if (u.User_ID) return api('partnerUser.save', { userId: u.User_ID, fullName: d.fullName, email: d.email, phone: d.phone }).then(function () { toast('User updated', 'success'); done(); });
        return api('partnerUser.save', d).then(function (r) { showTempPassword(r.username, r.temporaryPassword); reloadMeta(); done(); });
      }
    });
  }

  /* ---------- Admin users ---------- */
  function adminUsers(root) {
    setHeader('Admin users', 'Justlife Google Workspace accounts with full access', '<button class="btn btn-primary" data-add-admin>＋ <span class="lbl">Add admin</span></button>');
    api('admin.list').then(function (r) {
      var list = r.admins;
      root.innerHTML = '<div class="alert alert-info">Admins sign in with Google. Any verified @justlife.com account can sign in and is added here automatically (setting <b>ADMIN_ACCESS</b>). Set it to LISTED_ADMINS_ONLY to allow only the accounts below. <b>Deactivate</b> someone to block them; that ends their session immediately.</div>' +
        '<div class="card"><div class="card-body flush"><div class="table-wrap"><table class="table"><thead><tr><th>Admin</th><th>Role</th><th>Status</th><th>Last login</th><th>Created</th><th></th></tr></thead><tbody>' +
        list.map(function (a) {
          var me = a.Admin_ID === state.user.id;
          return '<tr><td><div class="cell-title">' + esc(a.Full_Name) + (me ? ' <span class="badge b-active plain">You</span>' : '') + '</div><div class="cell-sub">' + esc(a.Email) + '</div></td><td>' + esc(a.Role) + '</td><td>' + badge(a.Status, a.Status === 'Active' ? 'green' : 'grey') + '</td>' +
            '<td class="nowrap">' + fmtDateTime(a.Last_Login_At) + '</td><td class="nowrap">' + fmtDateTime(a.Created_At) + '<div class="cell-sub">' + esc(a.Created_By) + '</div></td>' +
            '<td class="nowrap"><button class="btn btn-sm" data-ad-edit="' + esc(a.Admin_ID) + '">Edit</button> ' + (me ? '' : '<button class="btn btn-sm ' + (a.Status === 'Active' ? 'btn-danger' : 'btn-success') + '" data-ad-status="' + esc(a.Admin_ID) + '">' + (a.Status === 'Active' ? 'Deactivate' : 'Activate') + '</button>') + '</td></tr>';
        }).join('') + '</tbody></table></div></div></div>';
      var find = function (id) { return list.filter(function (a) { return a.Admin_ID === id; })[0]; };
      $('[data-add-admin]').onclick = function () { adminModal(null); };
      $$('[data-ad-edit]').forEach(function (b) { b.onclick = function () { adminModal(find(b.getAttribute('data-ad-edit'))); }; });
      $$('[data-ad-status]').forEach(function (b) {
        b.onclick = function () {
          var a = find(b.getAttribute('data-ad-status')), to = a.Status === 'Active' ? 'Inactive' : 'Active';
          confirmBox({ title: (to === 'Active' ? 'Activate ' : 'Deactivate ') + a.Email, message: to === 'Inactive' ? 'This admin loses access immediately.' : 'This admin will be able to sign in again.', danger: to === 'Inactive', confirmLabel: to === 'Active' ? 'Activate' : 'Deactivate' })
            .then(function (ok) { if (!ok) return; return api('admin.setStatus', { adminId: a.Admin_ID, status: to }).then(function () { toast('Admin updated', 'success'); state.refresh(); }); })
            .catch(function (e) { toast(e.message, 'error'); });
        };
      });
    }).catch(function (e) { root.innerHTML = errorBlock(e); });
  }
  function adminModal(a) {
    a = a || {};
    formModal({
      title: a.Admin_ID ? 'Edit admin' : 'Add admin', size: 'sm', submitLabel: a.Admin_ID ? 'Save' : 'Add admin',
      body: field({ name: 'email', label: 'Google Workspace email', type: 'email', required: !a.Admin_ID, value: a.Email, readonly: !!a.Admin_ID, placeholder: 'name@justlife.com' }) +
        field({ name: 'fullName', label: 'Full name', required: true, value: a.Full_Name }) + field({ name: 'role', label: 'Role', type: 'select', required: true, options: ['Admin', 'Super Admin'], value: a.Role || 'Admin' }),
      onSubmit: function (d) { d.adminId = a.Admin_ID || ''; return api('admin.save', d).then(function () { toast(a.Admin_ID ? 'Admin updated' : 'Admin added – they can now sign in with Google', 'success'); state.refresh(); }); }
    });
  }

  /* ---------- Audit ---------- */
  function auditTable(logs) {
    if (!logs.length) return emptyState('No audit entries', '📜');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Changes</th></tr></thead><tbody>' +
      logs.map(function (l) {
        var changes = '';
        try {
          var b = l.Before_JSON ? JSON.parse(l.Before_JSON) : null, a = l.After_JSON ? JSON.parse(l.After_JSON) : null;
          if (b && a) {
            var keys = Object.keys(a).filter(function (k) { return String(a[k]) !== String(b[k]) && k !== 'Updated_At' && k !== 'Updated_By'; });
            changes = keys.length ? '<table class="diff">' + keys.map(function (k) { return '<tr><td><b>' + esc(k) + '</b></td><td class="from">' + esc(b[k] || '∅') + '</td><td class="to">' + esc(a[k]) + '</td></tr>'; }).join('') + '</table>' : '';
          } else if (a) changes = '<span class="cell-sub">Created</span>';
        } catch (e) {}
        return '<tr><td class="nowrap">' + fmtDateTime(l.Timestamp) + '</td><td>' + esc(l.Actor_Name) + '<div class="cell-sub">' + esc(l.Actor_Type) + '</div></td><td>' + badge(l.Action.replace(/_/g, ' '), 'active') + (l.Details ? '<div class="cell-sub">' + esc(l.Details) + '</div>' : '') + '</td>' +
          '<td>' + esc(l.Entity_Type) + '<div class="cell-sub mono">' + esc(l.Entity_ID) + '</div></td><td>' + changes + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function adminAudit(root) {
    var companies = (state.meta.companies || []).map(function (c) { return { value: c.id, label: c.name }; });
    setHeader('Audit log', 'Every change with before/after values', '<button class="btn" data-action="export" data-dataset="audit">⬇ <span class="lbl">Export</span></button>');
    root.innerHTML = '<div class="card"><div class="card-body"><form class="toolbar" id="audit-filters">' +
      field({ name: 'q', label: 'Search', placeholder: 'Actor, entity ID, details', attrs: ' type="search"' }).replace('class="field', 'class="field search') +
      field({ name: 'action', label: 'Action', type: 'select', options: [], placeholder: 'All actions' }) +
      field({ name: 'entityType', label: 'Entity', type: 'select', options: ['Client', 'Journey', 'Refill', 'Schedule', 'Payment', 'Company', 'Partner_User', 'Admin_User', 'Setting', 'Export', 'System'], placeholder: 'All entities' }) +
      field({ name: 'companyId', label: 'Company', type: 'select', options: companies, placeholder: 'All' }) +
      field({ name: 'from', label: 'From', type: 'date' }) + field({ name: 'to', label: 'To', type: 'date' }) + '</form></div></div>' +
      '<div class="card"><div class="card-head"><h2>Entries</h2><span class="muted small" id="audit-count"></span></div><div class="card-body flush" id="audit-table">' + skeleton(1) + '</div></div>';
    var form = $('#audit-filters'), actionsLoaded = false;
    var load = function () {
      api('audit.list', readForm(form)).then(function (r) {
        if (!actionsLoaded) { form.action.innerHTML = opts(r.actions, '', 'All actions'); actionsLoaded = true; }
        $('#audit-table').innerHTML = auditTable(r.logs);
        $('#audit-count').textContent = 'Showing ' + r.logs.length + ' of ' + r.total;
      }).catch(function (e) { $('#audit-table').innerHTML = errorBlock(e); });
    };
    form.addEventListener('input', debounce(load, 400)); form.addEventListener('change', load);
    load();
  }

  /* ---------- Settings ---------- */
  function adminSettings(root) {
    setHeader('System settings', 'Journey, refill, reporting and reminder configuration');
    api('settings.get').then(function (r) {
      var enumOpts = { CONVERSION_MODE: ['MIN_REFILLS', 'PAID_REGISTRATION'], CONVERSION_DENOMINATOR: ['ELIGIBLE', 'REGISTERED'], REMINDER_EMAILS_ENABLED: ['TRUE', 'FALSE'], ADMIN_ACCESS: ['ANY_COMPANY_ACCOUNT', 'LISTED_ADMINS_ONLY'] };
      var numeric = ['JOURNEY_MONTHS', 'DEFAULT_REFILL_INTERVAL_DAYS', 'SESSION_TTL_MINUTES', 'OVERDUE_GRACE_DAYS', 'CONVERSION_MIN_REFILLS', 'PASSWORD_MIN_LENGTH'];
      root.innerHTML = '<div class="card"><div class="card-body"><form class="form" id="settings-form"><div class="form-grid">' +
        r.settings.map(function (s) {
          var f = { name: s.key, label: s.key.replace(/_/g, ' '), value: s.value, hint: s.description };
          if (enumOpts[s.key]) { f.type = 'select'; f.options = enumOpts[s.key]; f.required = true; }
          else if (numeric.indexOf(s.key) >= 0) f.type = 'number';
          else if (/MEDICATIONS|REASONS|STATUSES|EMAILS|TYPES/.test(s.key)) { f.type = 'textarea'; f.full = true; }
          return field(f);
        }).join('') + '</div><div class="alert alert-error" id="settings-error" hidden></div><div class="row"><button class="btn btn-primary" type="submit">Save settings</button><span class="muted small">Changing JOURNEY_MONTHS only affects journeys registered afterwards.</span></div></form></div></div>' +
        '<div class="card"><div class="card-head"><h2>Reminders</h2></div><div class="card-body row"><button class="btn" data-run>Run reminder check now</button><span class="muted small">A daily time-driven trigger (07:00) runs this automatically.</span></div></div>';
      var form = $('#settings-form');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var d = readForm(form);
        Object.keys(d).forEach(function (k) { if (typeof d[k] === 'string') d[k] = d[k].replace(/\s*\n\s*/g, '|'); });
        $('#settings-error').hidden = true;
        api('settings.save', { settings: d }).then(function (x) { toast(x.changed.length ? 'Saved: ' + x.changed.join(', ') : 'No changes', 'success'); reloadMeta(); })
          .catch(function (er) { $('#settings-error').textContent = er.message; $('#settings-error').hidden = false; });
      });
      $('[data-run]').onclick = function () { api('reminders.run', {}, { requestId: uuid() }).then(function (x) { toast(x.created + ' new reminder(s), ' + x.emailed + ' email(s)', 'success'); }).catch(function (er) { toast(er.message, 'error'); }); };
    }).catch(function (e) { root.innerHTML = errorBlock(e); });
  }

  VIEWS.admin = { dashboard: adminDashboard, clients: viewClients, refills: viewRefills, payments: adminPayments, upsell: adminUpsell, companies: adminCompanies, admins: adminUsers, audit: adminAudit, settings: adminSettings };
  VIEWS.partner = { dashboard: partnerDashboard, clients: viewClients, refills: viewRefills, notifications: partnerNotifications, account: partnerAccount };

  /* ===========================================================================
   * 13. BOOT
   * ========================================================================= */
  function boot() {
    bindPartnerLogin();
    var saved = null;
    try { saved = sessionStorage.getItem(TOKEN_KEY); } catch (e) {}
    if (!saved) return showLogin();
    state.token = saved;
    api('auth.me', {}, { silentAuth: true }).then(function (r) { state.user = r.user; scheduleExpiry(r.user.expiresAt); return startApp(); })
      .catch(function (e) { clearSession(); showLogin(e.code === 'AUTH' ? '' : e.message); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
