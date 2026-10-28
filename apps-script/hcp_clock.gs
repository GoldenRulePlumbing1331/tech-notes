/**
 * hcp_clock.gs — Golden Rule Plumbing & Contracting
 *
 * "Job Clock": On my way / Start / Finish buttons that work with no signal (tech-notes repo → clock.html).
 * The phone stamps the moment the button is pressed, keeps it in an outbox, and sends it when signal returns.
 * HCP's public API cannot press those buttons (work_timestamps are read-only), so the script records the
 * real times where it can and tells the office what to fix:
 *   • a row in the "Job Clock" spreadsheet (Log tab)
 *   • a private note on the HCP job ("⏱ ON MY WAY 8:02 AM — pressed on the voice page by Mike Smith")
 *   • an email every 3 business days to REPORT_TO (dailyReport): every finished job since the last email where HCP
 *     has no Start/Finish — so it carries NO labor cost — with the travel/job time to type into Field Tech
 *     Details when the page has it; plus times that differ by more than REPORT_TOLERANCE_MIN and jobs still open.
 *
 * Labor cost in HCP = HCP's own tracked time × the tech's fully loaded rate (Team → Team member → Pay), with
 * Settings → Jobs → Costs & Materials → "Travel and time on jobs" on. Rates are not applied to time that was
 * already tracked, so set every tech's rate before relying on the numbers. Don't also post labor as job inputs —
 * that would count it twice.
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
 *  5. Run verifyAccess() (read-only). Run installDailyTrigger() once (6–7 AM report every day).
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
  REPORT_BACK_DAYS: 3,        // a report always covers at least the last 3 days so late presses and late Finishes get caught
  REPORT_EVERY_BUSINESS_DAYS: 3,   // the trigger runs daily; an email goes out once this many business days have passed
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
    const day = Utilities.formatDate(ckNow_(), tz, 'yyyy-MM-dd');
    const start = Utilities.parseDate(day + ' 00:00', tz, 'yyyy-MM-dd HH:mm'), end = new Date(start.getTime() + 86400000 - 1);
    const iso = d => Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
    const r = hcp_('get', `/jobs?scheduled_start_min=${encodeURIComponent(iso(start))}&scheduled_start_max=${encodeURIComponent(iso(end))}&employee_ids[]=${encodeURIComponent(emp.id)}&page_size=50`);
    jobs = (r.jobs || []).map(ckJobOut_).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  }
  return { who: who, today: Utilities.formatDate(ckNow_(), ckTz_(), 'yyyy-MM-dd'), jobs: jobs, employee_known: !!emp };
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

/* ───────────── nightly reconciliation ───────────── */

/**
 * Labor cost in HCP comes only from HCP's own On my way / Start / Finish times × each tech's fully loaded rate
 * (Team → Pay). The API can't write those times, so HCP's buttons are the system of record and this report is
 * the check. Every morning it looks at every job that was due in the last REPORT_BACK_DAYS and sorts them into:
 *   • NO LABOR COST — the job is finished but HCP never got a Start/Finish, so it carries $0 labor. If the tech
 *     pressed the page buttons, the email gives the travel/job time to type into Field Tech Details (with a link).
 *   • TIMES DIFFER — HCP has times but the page press is REPORT_TOLERANCE_MIN+ minutes away from them.
 *   • STILL OPEN — the day is over and the job isn't finished in HCP (Finish never pressed).
 *   • matched — HCP's times are there and agree with the page (or nobody used the page).
 * Only unfinished items are repeated day to day. Safe to re-run.
 */
/** Runs daily; emails only every REPORT_EVERY_BUSINESS_DAYS business days, covering everything since the last email. */
function dailyReport() {
  const tz = ckTz_();
  const today = Utilities.formatDate(ckNow_(), tz, 'yyyy-MM-dd');
  const last = props_().getProperty('CK_LAST_REPORT') || '';
  const since = last ? ckBusinessDays_(last, today) : CK.REPORT_EVERY_BUSINESS_DAYS;
  if (since < CK.REPORT_EVERY_BUSINESS_DAYS) { console.log(`Last report ${last}; ${since} business day(s) since — next one after ${CK.REPORT_EVERY_BUSINESS_DAYS}.`); return; }
  const calDays = last ? Math.round((Utilities.parseDate(today + ' 00:00', tz, 'yyyy-MM-dd HH:mm') - Utilities.parseDate(last + ' 00:00', tz, 'yyyy-MM-dd HH:mm')) / 86400000) : 0;
  if (ckReport_(Math.max(CK.REPORT_BACK_DAYS, calDays))) props_().setProperty('CK_LAST_REPORT', today);
}
function weeklyReport() { ckReport_(7); }   // manual wider sweep, doesn't move the schedule
function sendReportNow() { if (ckReport_(CK.REPORT_BACK_DAYS)) props_().setProperty('CK_LAST_REPORT', Utilities.formatDate(ckNow_(), ckTz_(), 'yyyy-MM-dd')); }
/** Mon–Fri days after `from` up to and including `to` (yyyy-MM-dd). */
function ckBusinessDays_(from, to) {
  const tz = ckTz_();
  let d = Utilities.parseDate(from + ' 12:00', tz, 'yyyy-MM-dd HH:mm'), n = 0;
  const end = Utilities.parseDate(to + ' 12:00', tz, 'yyyy-MM-dd HH:mm');
  while (d < end) { d = new Date(d.getTime() + 86400000); const wd = Utilities.formatDate(d, tz, 'EEE'); if (wd !== 'Sat' && wd !== 'Sun') n++; }
  return n;
}

function ckNow_() { return new Date(); }
function ckReport_(days) {
  const tz = ckTz_();
  const now = ckNow_();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const from = new Date(Utilities.parseDate(today + ' 00:00', tz, 'yyyy-MM-dd HH:mm').getTime() - days * 86400000);
  const until = new Date(Utilities.parseDate(today + ' 00:00', tz, 'yyyy-MM-dd HH:mm').getTime() - 1);   // up to the end of yesterday
  const iso = d => Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");

  // 1. Every job due in the window (one entry per job, not per appointment)
  const jobs = {};
  for (let page = 1; page <= 10; page++) {
    const r = hcp_('get', `/jobs?scheduled_start_min=${encodeURIComponent(iso(from))}&scheduled_start_max=${encodeURIComponent(iso(until))}&page=${page}&page_size=100`);
    (r.jobs || []).forEach(j => { jobs[j.id] = j; });
    if (!(r.jobs || []).length || page >= (r.total_pages || 0)) break;
  }

  // 2. Page presses in the window (plus any job a press mentions that the schedule search missed)
  const sh = ckSheet_('Log');
  const presses = {};   // jobId → tech → event → {pressed, row, note}
  const rows = sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, CK.LOG_HEADERS.length).getValues() : [];
  rows.forEach((r, i) => {
    const pressed = r[1] instanceof Date ? r[1] : ckParse_(r[1]);
    if (!pressed || !r[7] || pressed < from || pressed > now) return;
    const k = ckEventKey_(r[5]);
    const byTech = presses[r[7]] = presses[r[7]] || {};
    const ev = byTech[r[2]] = byTech[r[2]] || {};
    if (!ev[k] || pressed > ev[k].pressed) ev[k] = { pressed: pressed, row: i + 2, note: r[8] || '' };   // last press wins
    if (!jobs[r[7]]) { try { jobs[r[7]] = hcp_('get', '/jobs/' + encodeURIComponent(r[7])); } catch (e) { console.warn('job ' + r[7] + ': ' + e.message); } }
  });

  // 3. Sort each job
  const noLabor = [], differ = [], open = [], matched = [], apply = [];
  const fmt = d => d ? Utilities.formatDate(d, tz, 'EEE MM/d h:mm a') : '—';
  const mins = (a, b) => a && b && b > a ? Math.round((b - a) / 60000) : 0;
  Object.keys(jobs).forEach(id => {
    const j = jobs[id];
    const status = String(j.work_status || '');
    if (/cancel|needs scheduling/.test(status)) return;
    const ts = j.work_timestamps || {};
    const hcp = { omw: ckParse_(ts.on_my_way_at), start: ckParse_(ts.started_at), finish: ckParse_(ts.completed_at) };
    const done = /complete/.test(status);
    const c = j.customer || {};
    const base = { number: String(j.invoice_number || ''), job_id: id, customer: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || '',
      techs: (j.assigned_employees || []).map(e => [e.first_name, e.last_name].filter(Boolean).join(' ')).join(', ') || 'unassigned',
      due: fmt(ckParse_((j.schedule || {}).scheduled_start)), status: status, url: 'https://pro.housecallpro.com/app/jobs/' + id,
      hcp: { omw: fmt(hcp.omw), start: fmt(hcp.start), finish: fmt(hcp.finish) } };
    const byTech = presses[id] || {};
    const techNames = Object.keys(byTech);

    // Travel / job time to type in, per tech who pressed the page buttons (HCP's own time fills a gap)
    techNames.forEach(tech => {
      const ev = byTech[tech];
      const t = k => (ev[k] && ev[k].pressed) || hcp[k] || null;
      const tOmw = t('omw'), tStart = t('start'), tFinish = t('finish');
      const emp = ckEmployeeByName_(tech);
      if (emp && tStart && tFinish) apply.push({ job: base.number, job_id: id, customer: base.customer, tech: tech, pro_id: emp.id,
        travel_min: mins(tOmw, tStart), job_min: mins(tStart, tFinish),
        edit_url: `https://pro.housecallpro.com/app/jobs/${id}/technician_time_tracking_details/edit?job_uuid=${id}&pro_uuid=${emp.id}`,
        source: ['omw', 'start', 'finish'].map(k => k + ':' + (ev[k] ? 'page' : hcp[k] ? 'hcp' : 'none')).join(' ') });
    });

    const dueAt = ckParse_((j.schedule || {}).scheduled_start);
    if (!hcp.start || !hcp.finish) {
      if (!done && dueAt && dueAt > until) return;   // today's job, still going — nothing to say yet
      if (done) {
        const have = apply.filter(a => a.job_id === id);
        noLabor.push(Object.assign({}, base, { enter: have, missing: !hcp.start && !hcp.finish ? 'Start and Finish' : !hcp.start ? 'Start' : 'Finish' }));
      } else open.push(base);
      return;
    }
    // HCP has its times: compare to the page presses
    let worst = null;
    techNames.forEach(tech => Object.keys(byTech[tech]).forEach(k => {
      if (!hcp[k]) return;
      const d = Math.abs(hcp[k].getTime() - byTech[tech][k].pressed.getTime()) / 60000;
      if (d > CK.REPORT_TOLERANCE_MIN && (!worst || d > worst.min)) worst = { min: Math.round(d), tech: tech, event: CK.EVENTS[k], page: fmt(byTech[tech][k].pressed), hcp: fmt(hcp[k]), note: byTech[tech][k].note };
    }));
    if (worst) differ.push(Object.assign({}, base, worst, { enter: apply.filter(a => a.job_id === id) }));
    else matched.push(base);
  });
  const num = x => Number(String(x.number).split('-')[0]) || 0;
  [noLabor, differ, open, matched].forEach(l => l.sort((a, b) => num(a) - num(b)));

  // 4. Email
  const to = props_().getProperty('REPORT_TO');
  const span = Utilities.formatDate(from, tz, 'EEE MM/d') + ' – ' + Utilities.formatDate(until, tz, 'EEE MM/d');
  console.log(`Job Clock ${span}: ${noLabor.length} with no labor cost, ${differ.length} differ, ${open.length} still open, ${matched.length} matched.`);
  if (!to) { console.log('REPORT_TO not set — nothing emailed.'); return false; }
  const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const F = 'font-family:Arial,sans-serif';
  const table = (heads, body) => `<table border="1" cellpadding="6" style="border-collapse:collapse;${F};font-size:14px"><tr>${heads.map(h => '<th>' + esc(h) + '</th>').join('')}</tr>${body}</table>`;
  const enterCell = x => x.enter.length
    ? x.enter.map(a => `<b>${esc(a.tech)}</b>: travel ${ckHm_(a.travel_min)}, job ${ckHm_(a.job_min)} — <a href="${esc(a.edit_url)}">enter</a>`).join('<br>')
    : `no page presses either — ask ${esc(x.techs)}`;
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + props_().getProperty('CLOCK_SHEET_ID');
  const html = [
    `<p style="${F}">Job Clock — ${esc(span)}. <b>${noLabor.length}</b> finished job(s) carry no labor cost in HCP; ${differ.length} have times that differ; ${open.length} still open; ${matched.length} fine.</p>`,
    noLabor.length ? `<h3 style="${F};font-size:15px;color:#b00">No labor cost — HCP never got ${'Start/Finish'} (${noLabor.length})</h3>` +
      table(['Job', 'Customer', 'Tech(s)', 'Due', 'HCP is missing', 'Type into Field Tech Details'],
        noLabor.map(x => `<tr><td><a href="${esc(x.url)}">${esc(x.number)}</a></td><td>${esc(x.customer)}</td><td>${esc(x.techs)}</td><td>${esc(x.due)}</td><td>${esc(x.missing)}</td><td>${enterCell(x)}</td></tr>`).join('')) : `<p style="${F}">Every finished job has HCP time on it. 👍</p>`,
    differ.length ? `<h3 style="${F};font-size:15px">Times differ from the page (${differ.length})</h3>` +
      table(['Job', 'Customer', 'Tech', 'Button', 'Page', 'HCP', 'Off by', 'If the page is right'],
        differ.map(x => `<tr><td><a href="${esc(x.url)}">${esc(x.number)}</a></td><td>${esc(x.customer)}</td><td>${esc(x.tech)}</td><td>${esc(x.event)}</td><td><b>${esc(x.page)}</b></td><td>${esc(x.hcp)}</td><td>${x.min} min</td><td>${enterCell(x)}</td></tr>`).join('')) : '',
    open.length ? `<h3 style="${F};font-size:15px">Still open in HCP (${open.length})</h3>` +
      table(['Job', 'Customer', 'Tech(s)', 'Due', 'Status', 'HCP has'],
        open.map(x => `<tr><td><a href="${esc(x.url)}">${esc(x.number)}</a></td><td>${esc(x.customer)}</td><td>${esc(x.techs)}</td><td>${esc(x.due)}</td><td>${esc(x.status)}</td><td>OMW ${esc(x.hcp.omw)} · Start ${esc(x.hcp.start)}</td></tr>`).join('')) : '',
    `<p style="${F};font-size:12px;color:#666">Labor cost = HCP's tracked time × the tech's fully loaded rate (Team → Pay); typing the time into Field Tech Details fixes it. Full log: <a href="${sheetUrl}">Job Clock sheet</a>.</p>`,
    apply.length ? `<pre style="font-size:10px;color:#999">JOBCLOCK-DATA: ${esc(JSON.stringify({ span: span, apply: apply.filter(a => noLabor.concat(differ).some(x => x.job_id === a.job_id)) }))}</pre>` : '',
  ].join('\n');
  const text = `Job Clock — ${span}: ${noLabor.length} finished job(s) with no labor cost in HCP; ${differ.length} differ; ${open.length} still open; ${matched.length} fine.\n\n` +
    (noLabor.length ? 'NO LABOR COST:\n' + noLabor.map(x => `Job ${x.number} (${x.customer}) — ${x.techs} — missing ${x.missing}` + (x.enter.length ? x.enter.map(a => `; ${a.tech}: travel ${ckHm_(a.travel_min)}, job ${ckHm_(a.job_min)} ${a.edit_url}`).join('') : '; no page presses — ask the tech')).join('\n') + '\n\n' : '') +
    (differ.length ? 'TIMES DIFFER:\n' + differ.map(x => `Job ${x.number} (${x.customer}) — ${x.tech} ${x.event}: page ${x.page} | HCP ${x.hcp} (${x.min} min) ${x.url}`).join('\n') + '\n\n' : '') +
    (open.length ? 'STILL OPEN:\n' + open.map(x => `Job ${x.number} (${x.customer}) — ${x.techs} — ${x.status} ${x.url}`).join('\n') + '\n\n' : '') + sheetUrl;
  const subject = noLabor.length ? `Job Clock — ${noLabor.length} job${noLabor.length === 1 ? '' : 's'} with no labor cost in HCP (${span})` : `Job Clock — all finished jobs have time in HCP (${span})`;
  GmailApp.sendEmail(to, subject, text, { cc: props_().getProperty('REPORT_CC') || '', htmlBody: html, name: 'Golden Rule Job Clock' });

  // 5. Mark the log rows this run looked at
  const stamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const verdict = {};
  noLabor.forEach(x => { verdict[x.job_id] = 'no labor cost'; }); differ.forEach(x => { verdict[x.job_id] = 'differs'; }); open.forEach(x => { verdict[x.job_id] = 'open'; }); matched.forEach(x => { verdict[x.job_id] = 'ok'; });
  Object.keys(presses).forEach(id => Object.keys(presses[id]).forEach(tech => Object.keys(presses[id][tech]).forEach(k => {
    try { if (sh) sh.getRange(presses[id][tech][k].row, 10).setValue(stamp + ' ' + (verdict[id] || 'ok')); } catch (_) {}
  })));
  console.log(`✅ Report sent to ${to}.`);
  return true;
}
function ckHm_(min) { min = Number(min) || 0; return Math.floor(min / 60) + 'h ' + String(min % 60).padStart(2, '0') + 'm'; }
function ckEventKey_(label) { return Object.keys(CK.EVENTS).filter(k => CK.EVENTS[k] === label)[0] || 'omw'; }

/** Checks every morning 6–7 AM; emails every REPORT_EVERY_BUSINESS_DAYS business days. */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => ['weeklyReport', 'dailyReport'].indexOf(t.getHandlerFunction()) !== -1).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(6).create();
  console.log(`✅ dailyReport checks every day 6–7 AM and emails every ${CK.REPORT_EVERY_BUSINESS_DAYS} business days.`);
}
function installWeeklyTrigger() { installDailyTrigger(); }

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
  console.log(props_().getProperty('REPORT_TO') ? `✅ Daily report → ${props_().getProperty('REPORT_TO')}` : '⚠️ REPORT_TO not set — dailyReport() will only log.');
  console.log(`Time zone: ${ckTz_()} (should be America/New_York)`);
  console.log(ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'dailyReport') ? '✅ Daily trigger installed.' : '⚠️ Run installDailyTrigger() for the morning email.');
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
