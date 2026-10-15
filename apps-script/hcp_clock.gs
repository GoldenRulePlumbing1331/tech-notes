/**
 * hcp_clock.gs — Golden Rule Plumbing & Contracting
 *
 * "Job Clock": On my way / Start / Finish buttons that work with no signal (tech-notes repo → clock.html).
 * The phone stamps the moment the button is pressed, keeps it in an outbox, and sends it when signal returns.
 * HCP's public API cannot press those buttons (work_timestamps are read-only), so the script records the
 * real times where it can and tells the office what to fix:
 *   • a row in the "Job Clock" spreadsheet (Log tab)
 *   • a private note on the HCP job ("⏱ ON MY WAY 8:02 AM — pressed on the voice page by Mike Smith")
 *   • a Monday-morning email to REPORT_TO listing every press where HCP's own timestamp is missing or
 *     differs by more than REPORT_TOLERANCE_MIN, with the time to enter.
 *
 * ───────────── ONE-TIME SETUP ─────────────
 *  1. script.google.com → New project "HCP Job Clock" → paste this file (owner: golden.rule.calendar@gmail.com).
 *  2. Project Settings → "Show appsscript.json" → set "timeZone": "America/New_York".
 *  3. Script Properties:
 *       HCP_API_KEY  = <HCP key>
 *       TECH_CODES   = paste from the New Job project (same codes everywhere)
 *       REPORT_TO    = office email(s) for the Monday report, comma-separated
 *       REPORT_CC    = optional
 *  4. Run setupSheet() → creates the "Job Clock" spreadsheet and saves its ID.
 *  5. Run verifyAccess() (read-only). Run installWeeklyTrigger() once (Monday 6–7 AM report).
 *  6. Deploy → Web app (Execute as Me, Anyone) → URL into config.js as "clock".
 *
 * Actions (POST JSON, all need "token"):
 *   init   {}                              → who, today's jobs for this tech with HCP's current timestamps
 *   job    {number}                        → one job by number (customer, address, timestamps)
 *   stamp  {req_id, event, at, job_id | number, note} → records the press; replays with the same req_id are no-ops
 */

const CK = {
  BASE: 'https://api.housecallpro.com',
  SHEET_NAME: 'Job Clock',
  LOG_HEADERS: ['Sent', 'Pressed at', 'Tech', 'Job', 'Customer', 'Event', 'HCP had (at send)', 'Job ID', 'Note', 'Reported'],
  EVENTS: { omw: 'ON MY WAY', start: 'START', finish: 'FINISH' },
  HCP_FIELD: { omw: 'on_my_way_at', start: 'started_at', finish: 'completed_at' },
  REPORT_TOLERANCE_MIN: 15,
  JOB_SCAN_PAGES: 15,
  CODE_LENGTH: 8,
};

/* ───────────── web app ───────────── */

function doPost(e) {
  let p = {};
  try { p = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (_) { p = e.parameter || {}; }
  return jsonOut_(clockAction_(p));
}
function doGet() { return ContentService.createTextOutput('HCP Job Clock web app is running.'); }

function clockAction_(p) {
  try {
    const who = whoIs_(p.token);
    switch (p.action) {
      case 'init':  return Object.assign({ ok: true }, ckInit_(who));
      case 'job':   return { ok: true, job: ckJobOut_(ckJobByNumber_(p.number)) };
      case 'stamp': return ckStamp_(p, who);
      default:      throw new Error('Unknown action.');
    }
  } catch (err) {
    console.log('clock ' + p.action + ' ❌ ' + err.message);
    return { ok: false, error: err.message };
  }
}
function jsonOut_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function ckInit_(who) {
  const emp = ckEmployeeByName_(who);
  let jobs = [];
  if (emp) {
    const tz = ckTz_();
    const day = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    const start = Utilities.parseDate(day + ' 00:00', tz, 'yyyy-MM-dd HH:mm'), end = new Date(start.getTime() + 86400000 - 1);
    const iso = d => Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
    const r = hcp_('get', `/jobs?scheduled_start_min=${encodeURIComponent(iso(start))}&scheduled_start_max=${encodeURIComponent(iso(end))}&employee_ids[]=${encodeURIComponent(emp.id)}&page_size=50`);
    jobs = (r.jobs || []).map(ckJobOut_).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  }
  return { who: who, today: Utilities.formatDate(new Date(), ckTz_(), 'yyyy-MM-dd'), jobs: jobs, employee_known: !!emp };
}

function ckJobOut_(j) {
  const c = j.customer || {}, a = j.address || {}, s = j.schedule || {}, ts = j.work_timestamps || {};
  return { id: j.id, number: String(j.invoice_number || ''), customer: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || '(no name)',
           address: [a.street, a.city].filter(Boolean).join(', '), start: s.scheduled_start || '', status: j.work_status || '',
           start_text: s.scheduled_start ? Utilities.formatDate(ckParse_(s.scheduled_start), ckTz_(), 'h:mm a') : '',
           hcp: { omw: ckFmt_(ts.on_my_way_at), start: ckFmt_(ts.started_at), finish: ckFmt_(ts.completed_at) } };
}

/* ───────────── the press ───────────── */

function ckStamp_(p, who) {
  const reqId = String(p.req_id || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (reqId) { const prior = ckRecall_(reqId); if (prior) return prior; }
  const result = withLock_(() => ckStampLocked_(p, who));
  if (reqId && result.ok) ckRemember_(reqId, result);
  return result;
}

function ckStampLocked_(p, who) {
  const event = String(p.event || '').toLowerCase();
  if (!CK.EVENTS[event]) throw new Error('Unknown button.');
  const at = ckParse_(p.at);
  if (!at || isNaN(at.getTime())) throw new Error('No time on that press.');
  const job = p.job_id ? hcp_('get', '/jobs/' + encodeURIComponent(p.job_id)) : ckJobByNumber_(p.number);
  const out = ckJobOut_(job);
  const tz = ckTz_();
  const now = new Date();
  const pressed = Utilities.formatDate(at, tz, 'EEE MMM d, h:mm a');
  const hcpNow = out.hcp[event] || '';
  const note = String(p.note || '').trim().slice(0, 200);
  const late = now.getTime() - at.getTime() > 5 * 60000;   // sent well after the press = it was queued offline

  // 1. Sheet
  let logged = false;
  try {
    const sh = ckSheet_('Log');
    if (sh) { sh.appendRow([now, at, who, out.number, out.customer, CK.EVENTS[event], hcpNow, out.id, note, '']); logged = true; }
  } catch (e) { console.warn('log failed: ' + e.message); }

  // 2. Private note on the job — the office's "what time to enter" if HCP's button never got pressed
  let noted = false;
  try {
    hcp_('post', `/jobs/${job.id}/notes`, { content: `⏱ ${CK.EVENTS[event]} ${pressed} — pressed on the voice page by ${who}` +
      (late ? ` (sent ${Utilities.formatDate(now, tz, 'h:mm a')}, phone had no signal at the time)` : '') + (note ? `. ${note}` : '') +
      (hcpNow ? `\nHCP already shows ${CK.EVENTS[event]} ${hcpNow}.` : '\nHCP button not pressed yet — office: please set it to this time.') });
    noted = true;
  } catch (e) { console.warn('note failed: ' + e.message); }

  console.log(`clock ✅ ${CK.EVENTS[event]} job ${out.number} ${pressed} by ${who}; hcp=${hcpNow || 'none'}; note=${noted}`);
  return { ok: true, message: `✅ ${CK.EVENTS[event]} ${pressed} recorded for job ${out.number}` + (hcpNow ? ` (HCP already has ${hcpNow}).` : '. The office will set HCP to this time.'),
           job: out, event: event, pressed: pressed, hcp_had: hcpNow, logged: logged, noted: noted };
}

/* ───────────── Monday report ───────────── */

/** Emails REPORT_TO every press from the last 7 days where HCP's own timestamp is missing or off. Safe to re-run. */
function weeklyReport() {
  const sh = ckSheet_('Log');
  if (!sh || sh.getLastRow() < 2) { console.log('No presses logged.'); return; }
  const tz = ckTz_();
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, CK.LOG_HEADERS.length).getValues();
  const since = Date.now() - 7 * 86400000;
  const byJob = {};
  rows.forEach((r, i) => {
    const sent = r[0] instanceof Date ? r[0].getTime() : Date.parse(r[0]);
    if (!(sent >= since) || !r[7]) return;
    (byJob[r[7]] = byJob[r[7]] || []).push({ row: i + 2, pressed: r[1] instanceof Date ? r[1] : new Date(r[1]), tech: r[2], number: r[3], customer: r[4], event: r[5], note: r[8], jobId: r[7] });
  });
  const fix = [], ok = [], apply = [];
  Object.keys(byJob).forEach(jobId => {
    let job = null;
    try { job = hcp_('get', '/jobs/' + encodeURIComponent(jobId)); } catch (e) { console.warn('job ' + jobId + ': ' + e.message); }
    const ts = (job && job.work_timestamps) || {};
    // keep the LAST press per event (a tech can re-press by mistake)
    const last = {};
    byJob[jobId].forEach(s => { const k = ckEventKey_(s.event); if (!last[k] || s.pressed > last[k].pressed) last[k] = s; });
    // Durations for HCP's "Field tech details" panel (travel = On my way → Start, job = Start → Finish).
    // Page stamps win; HCP's own timestamp fills a gap. Carried in the email for the Monday Chrome run.
    const t = k => (last[k] && last[k].pressed) || (ts[CK.HCP_FIELD[k]] ? ckParse_(ts[CK.HCP_FIELD[k]]) : null);
    const tOmw = t('omw'), tStart = t('start'), tFinish = t('finish');
    const first = byJob[jobId][0];
    const emp = ckEmployeeByName_(first.tech);
    if (job && emp && tStart && (tOmw || tFinish)) {
      const mins = (a, b) => a && b && b > a ? Math.round((b - a) / 60000) : 0;
      apply.push({ job: first.number, job_id: jobId, customer: first.customer, tech: first.tech, pro_id: emp.id,
        travel_min: mins(tOmw, tStart), job_min: mins(tStart, tFinish),
        edit_url: `https://pro.housecallpro.com/app/jobs/${jobId}/technician_time_tracking_details/edit?job_uuid=${jobId}&pro_uuid=${emp.id}`,
        source: ['omw', 'start', 'finish'].map(k => k + ':' + (last[k] ? 'page' : ts[CK.HCP_FIELD[k]] ? 'hcp' : 'none')).join(' ') });
    }
    Object.keys(last).forEach(k => {
      const s = last[k];
      const hcpRaw = ts[CK.HCP_FIELD[k]];
      const hcpAt = hcpRaw ? ckParse_(hcpRaw) : null;
      const diffMin = hcpAt ? Math.abs(hcpAt.getTime() - s.pressed.getTime()) / 60000 : null;
      const entry = { number: s.number, customer: s.customer || ((job && job.customer) ? [job.customer.first_name, job.customer.last_name].filter(Boolean).join(' ') : ''), tech: s.tech, event: CK.EVENTS[k],
        page: Utilities.formatDate(s.pressed, tz, 'EEE MM/d h:mm a'), hcp: hcpAt ? Utilities.formatDate(hcpAt, tz, 'EEE MM/d h:mm a') : '—', note: s.note || '',
        status: !hcpAt ? 'MISSING in HCP' : diffMin > CK.REPORT_TOLERANCE_MIN ? `off by ${Math.round(diffMin)} min` : 'ok', row: s.row };
      (entry.status === 'ok' ? ok : fix).push(entry);
    });
  });
  const weekOf = Utilities.formatDate(new Date(since), tz, 'MMM d') + ' – ' + Utilities.formatDate(new Date(), tz, 'MMM d');
  const to = props_().getProperty('REPORT_TO');
  if (!to) { console.log(`REPORT_TO not set. ${fix.length} to fix, ${ok.length} ok.`); return; }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const order = { 'ON MY WAY': 0, 'START': 1, 'FINISH': 2 };
  fix.sort((a, b) => a.number.localeCompare(b.number) || order[a.event] - order[b.event]);
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + props_().getProperty('CLOCK_SHEET_ID');
  const html = [`<p style="font-family:Arial,sans-serif">Job Clock — week of ${esc(weekOf)}. <b>${fix.length}</b> time(s) to enter or fix in HCP; ${ok.length} already match.</p>`,
    fix.length ? '<table border="1" cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px"><tr><th>Job</th><th>Customer</th><th>Tech</th><th>Button</th><th>Pressed on the page</th><th>HCP shows</th><th>Action</th><th>Note</th></tr>' +
      fix.map(f => `<tr><td>${esc(f.number)}</td><td>${esc(f.customer)}</td><td>${esc(f.tech)}</td><td>${esc(f.event)}</td><td><b>${esc(f.page)}</b></td><td>${esc(f.hcp)}</td><td>${esc(f.status)}</td><td>${esc(f.note)}</td></tr>`).join('') + '</table>' : '<p style="font-family:Arial,sans-serif">Nothing to fix this week.</p>',
    `<p style="font-family:Arial,sans-serif;font-size:12px;color:#666">Each job also has a private "⏱" note with the time. Full log: <a href="${sheetUrl}">Job Clock sheet</a>.</p>`,
    apply.length ? `<h3 style="font-family:Arial,sans-serif;font-size:14px">Field tech details to enter (travel / job time)</h3><table border="1" cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px"><tr><th>Job</th><th>Tech</th><th>Travel</th><th>Job time</th><th></th></tr>` +
      apply.map(a => `<tr><td>${esc(a.job)} ${esc(a.customer)}</td><td>${esc(a.tech)}</td><td>${ckHm_(a.travel_min)}</td><td>${ckHm_(a.job_min)}</td><td><a href="${esc(a.edit_url)}">open in HCP</a></td></tr>`).join('') + '</table>' +
      `<p style="font-family:Arial,sans-serif;font-size:12px;color:#666">To have Claude enter these: open a Claude chat with Chrome connected and run <b>apply-job-clock-times</b>.</p>` +
      `<pre style="font-size:10px;color:#999">JOBCLOCK-DATA: ${esc(JSON.stringify({ week: weekOf, apply: apply }))}</pre>` : ''].join('\n');
  const text = `Job Clock — week of ${weekOf}: ${fix.length} time(s) to enter or fix in HCP; ${ok.length} already match.\n\n` +
    fix.map(f => `Job ${f.number} (${f.customer}) — ${f.tech} — ${f.event}: page ${f.page} | HCP ${f.hcp} → ${f.status}${f.note ? ' — ' + f.note : ''}`).join('\n') +
    (apply.length ? `\n\nField tech details to enter:\n` + apply.map(a => `Job ${a.job} (${a.customer}) — ${a.tech}: travel ${ckHm_(a.travel_min)}, job ${ckHm_(a.job_min)} — ${a.edit_url}`).join('\n') + `\n\nJOBCLOCK-DATA: ${JSON.stringify({ week: weekOf, apply: apply })}` : '') + `\n\n${sheetUrl}`;
  GmailApp.sendEmail(to, `Job Clock — ${fix.length} time${fix.length === 1 ? '' : 's'} to update in HCP (week of ${weekOf})`, text,
    { cc: props_().getProperty('REPORT_CC') || '', htmlBody: html, name: 'Golden Rule Job Clock' });
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  fix.concat(ok).forEach(f => { try { sh.getRange(f.row, 10).setValue(stamp + (f.status === 'ok' ? ' ok' : ' ' + f.status)); } catch (_) {} });
  console.log(`✅ Report sent to ${to}: ${fix.length} to fix, ${ok.length} ok.`);
}
function ckHm_(min) { min = Number(min) || 0; return Math.floor(min / 60) + 'h ' + String(min % 60).padStart(2, '0') + 'm'; }
function ckEventKey_(label) { return Object.keys(CK.EVENTS).filter(k => CK.EVENTS[k] === label)[0] || 'omw'; }

function installWeeklyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'weeklyReport').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('weeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  console.log('✅ weeklyReport runs every Monday between 6 and 7 AM.');
}

/* ───────────── jobs, employees, dates ───────────── */

function ckJobByNumber_(number) {
  const want = String(number || '').trim().replace(/^#/, '');
  if (!/^\d+(-\d+)?$/.test(want)) throw new Error(`"${number}" doesn't look like a job number.`);
  const key = 'job_' + want;
  const cached = props_().getProperty(key);
  if (cached) { try { return hcp_('get', '/jobs/' + cached); } catch (_) { props_().deleteProperty(key); } }
  const segs = [];
  for (let page = 1; page <= CK.JOB_SCAN_PAGES; page++) {
    const r = hcp_('get', `/jobs?page=${page}&page_size=100&sort_by=created_at&sort_direction=desc`);
    const jobs = r.jobs || [];
    for (const j of jobs) {
      const inv = String(j.invoice_number || '').trim();
      if (inv === want) { props_().setProperty(key, j.id); return j; }
      if (inv.indexOf(want + '-') === 0) segs.push(j);
    }
    if (!jobs.length || page >= (r.total_pages || 0)) break;
    if (segs.length) break;
  }
  if (segs.length === 1) return segs[0];
  if (segs.length > 1) throw new Error(`Job ${want} has segments ${segs.map(j => j.invoice_number).join(', ')} — use the full number.`);
  throw new Error(`Couldn't find job ${want} in the ${CK.JOB_SCAN_PAGES * 100} most recent jobs.`);
}

function ckEmployeeByName_(name) {
  const cache = CacheService.getScriptCache();
  let list = null;
  try { list = JSON.parse(cache.get('ck_emps') || 'null'); } catch (_) {}
  if (!list) {
    list = [];
    for (let page = 1; page <= 10; page++) {
      const r = hcp_('get', `/employees?page=${page}&page_size=100`);
      (r.employees || []).forEach(e => list.push({ id: e.id, name: [e.first_name, e.last_name].filter(Boolean).join(' ').trim() }));
      if (page >= (r.total_pages || 0)) break;
    }
    cache.put('ck_emps', JSON.stringify(list), 21600);
  }
  const want = String(name || '').trim().toLowerCase();
  return list.filter(e => e.name.toLowerCase() === want)[0] || null;
}

function ckTz_() { return Session.getScriptTimeZone() || 'America/New_York'; }
/** HCP sends 'YYYY-MM-DDTHH:MM:SS' (UTC, no zone); phones send full ISO with Z/offset. */
function ckParse_(s) {
  if (s instanceof Date) return s;
  s = String(s || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function ckFmt_(s) { const d = ckParse_(s); return d ? Utilities.formatDate(d, ckTz_(), 'EEE h:mm a') : ''; }

function ckRecall_(rid) {
  const c = CacheService.getScriptCache().get('ck_req_' + rid);
  if (c) { try { return JSON.parse(c); } catch (_) {} }
  const v = props_().getProperty('ck_req_' + rid);
  try { return v ? JSON.parse(v).r : null; } catch (_) { return null; }
}
function ckRemember_(rid, result) {
  try { CacheService.getScriptCache().put('ck_req_' + rid, JSON.stringify(result), 21600); } catch (_) {}
  try {
    const props = props_();
    props.setProperty('ck_req_' + rid, JSON.stringify({ t: Date.now(), r: { ok: true, message: result.message, replay: true, event: result.event, pressed: result.pressed } }));
    const old = Date.now() - 7 * 86400000;
    const all = props.getProperties();
    Object.keys(all).forEach(k => { if (k.indexOf('ck_req_') !== 0) return; let t = 0; try { t = JSON.parse(all[k]).t; } catch (_) {} if (!t || t < old) props.deleteProperty(k); });
  } catch (_) {}
}

/* ───────────── access codes, HCP client, helpers ───────────── */

function whoIs_(token) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('bad_codes') || 0);
  if (fails >= 20) throw new Error('Too many wrong codes. Try again in 10 minutes.');
  const t = String(token || '').trim();
  const codes = techCodes_();
  if (t && codes[t]) return codes[t];
  cache.put('bad_codes', String(fails + 1), 600);
  throw new Error('That access code isn’t valid.');
}
function techCodes_() { try { return JSON.parse(props_().getProperty('TECH_CODES') || '{}'); } catch (_) { return {}; } }

function hcp_(method, path, body) {
  const opts = { method: method, headers: { Authorization: 'Token ' + apiKey_(), Accept: 'application/json' }, muteHttpExceptions: true };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = UrlFetchApp.fetch(CK.BASE + path, opts);
    const code = res.getResponseCode();
    if (code === 429) { const h = res.getHeaders(); const wait = Number(h['Retry-After'] || h['retry-after'] || 2); Utilities.sleep(Math.min(Math.max(wait, 1), 10) * 1000); continue; }
    const text = res.getContentText();
    if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
    throw new Error(`HCP ${method.toUpperCase()} ${path.split('?')[0]} → ${code}: ${text.slice(0, 200)}`);
  }
  throw new Error('HCP rate limit — gave up after retries.');
}
function props_() { return PropertiesService.getScriptProperties(); }
function apiKey_() { const k = props_().getProperty('HCP_API_KEY'); if (!k) throw new Error('Script property HCP_API_KEY is not set.'); return k; }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Busy — try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}
function ckSheet_(tab) {
  const id = props_().getProperty('CLOCK_SHEET_ID');
  if (!id) return null;
  try { return SpreadsheetApp.openById(id).getSheetByName(tab); } catch (_) { return null; }
}

/* ───────────── setup & checks (run from the editor) ───────────── */

function setupSheet() {
  let id = props_().getProperty('CLOCK_SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (_) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create(CK.SHEET_NAME); id = ss.getId(); props_().setProperty('CLOCK_SHEET_ID', id); }
  let sh = ss.getSheetByName('Log');
  if (!sh) sh = ss.insertSheet('Log');
  if (sh.getLastRow() === 0) { sh.appendRow(CK.LOG_HEADERS); sh.setFrozenRows(1); sh.getRange(1, 1, 1, CK.LOG_HEADERS.length).setFontWeight('bold'); }
  const first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' && ss.getSheets().length > 1) ss.deleteSheet(first);
  console.log(`✅ Sheet ready: ${ss.getUrl()}`);
}

/** Read-only check. */
function verifyAccess() {
  console.log(props_().getProperty('CLOCK_SHEET_ID') ? '✅ Sheet: https://docs.google.com/spreadsheets/d/' + props_().getProperty('CLOCK_SHEET_ID') : '❌ No sheet yet — run setupSheet().');
  const r = hcp_('get', '/jobs?page=1&page_size=1&sort_by=created_at&sort_direction=desc');
  const j = (r.jobs || [])[0];
  console.log(`✅ Jobs readable — ${r.total_items} total; newest ${j ? j.invoice_number : 'n/a'}; its timestamps: ${JSON.stringify(j ? j.work_timestamps : {})}`);
  const codes = techCodes_();
  const names = Object.keys(codes).map(c => codes[c]);
  const known = names.filter(n => ckEmployeeByName_(n));
  console.log(`✅ Access codes for ${names.length} people; ${known.length} match an HCP employee by name (those get a "today's jobs" list).`);
  if (names.length !== known.length) console.log('   No HCP match for: ' + names.filter(n => !ckEmployeeByName_(n)).join(', ') + ' — they type the job number instead.');
  console.log(props_().getProperty('REPORT_TO') ? `✅ Monday report → ${props_().getProperty('REPORT_TO')}` : '⚠️ REPORT_TO not set — weeklyReport() will only log.');
  console.log(`Time zone: ${ckTz_()} (should be America/New_York)`);
  console.log(ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'weeklyReport') ? '✅ Weekly trigger installed.' : '⚠️ Run installWeeklyTrigger() for the Monday email.');
}

function generateTechCodes() {
  const codes = techCodes_();
  const have = {};
  Object.keys(codes).forEach(c => { have[codes[c]] = c; });
  for (let page = 1; page <= 10; page++) {
    const r = hcp_('get', `/employees?page=${page}&page_size=100`);
    (r.employees || []).forEach(e => {
      const name = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
      if (!name || have[name]) return;
      let code;
      do { code = ''; for (let i = 0; i < CK.CODE_LENGTH; i++) code += Math.floor(Math.random() * 10); } while (codes[code] || code[0] === '0');
      codes[code] = name; have[name] = code;
    });
    if (page >= (r.total_pages || 0)) break;
  }
  props_().setProperty('TECH_CODES', JSON.stringify(codes));
  console.log('Access codes:\n' + Object.keys(have).sort().map(n => `${n}: ${have[n]}`).join('\n'));
}
