/**
 * hcp_job_inputs.gs — Golden Rule Plumbing & Contracting
 *
 * "Job Inputs" upload: the office drops the Weinstein "Order History Detail" CSV on job-inputs.html, the page
 * parses it in the browser and sends the lines here. This script matches every line to its HCP job (from the
 * Customer PO# = our job number), checks the job is finished, nets returns, skips anything already on the job,
 * shows a plan, and on "Apply all" posts the material to the job's Job Inputs (job_input_materials/bulk_update).
 * Same rules as the old D:\Job_Uploads Python scripts — this replaces them; nothing has to run on a laptop.
 *
 *   • Only COMPLETED jobs get inputs. Lines for unfinished / not-yet-found jobs are saved in the sheet's
 *     "Pending" tab and retried every morning by retryPending() — no re-upload needed.
 *   • Every posted input carries description "Weinstein #<order> <ship date>", so re-uploading the same CSV
 *     (or an overlapping export) never double-counts. The "Posted" tab also remembers every line fingerprint.
 *   • Returns ("PO # return", negative qty) are matched to the original sale (order # + job # from the
 *     Comment) and netted: inside the batch first, then against the entry already on the HCP job (qty reduced
 *     in place; "(RETURNED)" at zero). A return with nothing to net against is flagged, never posted negative.
 *   • Duplicate-part guard: the same part already on the job (any order) and the line is $100+ → held, shown
 *     with an "upload anyway" box. Cheaper repeats post normally.
 *   • Several segments (49040-1, 49040-2) for a bare "49040" → the one scheduled closest to the ship date.
 *
 * ───────────── ONE-TIME SETUP ─────────────
 *  1. script.google.com → New project "HCP Job Inputs" → paste this file (owner: golden.rule.calendar@gmail.com).
 *  2. Project Settings → "Show appsscript.json" → set "timeZone": "America/New_York".
 *  3. Script Properties:  HCP_API_KEY, TECH_CODES (same as the other tools), REPORT_TO (office email for the
 *     morning summary when the retry posts something).  Optional: WARRANTY_TAGS = Bradford White Warranty
 *     (comma-separated job tags whose water-heater UNIT should be left off; empty = off, same as the old config).
 *  4. Run setupSheet() → creates the "Job Inputs Uploads" spreadsheet (Posted + Pending tabs) and saves its ID.
 *  5. Run verifyAccess() (read-only). Run installDailyTrigger() once (retryPending every morning 6–7 AM).
 *  6. Deploy → Web app (Execute as Me, Anyone) → URL into config.js as "jobInputs".
 *
 * Actions (POST JSON, all need "token"):
 *   init     {}                         → who, sheet url, pending count
 *   preview  {lines:[…]}                → plan: groups per job with add / net / skip / held / flag items
 *   apply    {req_id, groups:[{job_id, ref, items:[…]}], pending:[lines]} → posts, logs, saves pending
 */

const JI = {
  BASE: 'https://api.housecallpro.com',
  SHEET_NAME: 'Job Inputs Uploads',
  POSTED_HEADERS: ['Posted', 'By', 'Job', 'Customer', 'Order', 'Part', 'Qty', 'Unit cost', 'Name', 'Action', 'Job ID', 'Key'],
  PENDING_HEADERS: ['Added', 'By', 'Job ref', 'Order', 'Ship date', 'PO text', 'Part', 'Description', 'Qty', 'Ext', 'UOM', 'Kind', 'Orig order', 'Reason', 'Key'],
  COMPLETED: ['complete rated', 'complete unrated', 'completed'],
  CANCELED: ['user canceled', 'pro canceled', 'canceled'],
  DUP_MIN_CENTS: 10000,          // duplicate-part guard kicks in at a $100 line total
  JOB_SCAN_PAGES: 25,            // 2,500 most recent jobs
  TAG_RE: /Weinstein\s*#\s*([A-Za-z0-9.\-/]+)/i,
  WH_UNIT_RE: /WATER\s*HEATER|WTR\s*HTR/i,
  WH_TANK_RE: /(?:BRADFORD|BRADWHIT|\bBW\b|RHEEM|A\.?\s?O\.?\s?SMITH|\bSTATE\b|RUUD).*\b\d{2,3}\s*-?\s*GAL|\b\d{2,3}\s*-?\s*GAL.*(?:WATER\s*HEATER|WTR\s*HTR)/i,
  WH_ACCESSORY_RE: /\bPAN\b|DESCAL|VALVE|SENSOR|CONNECT|\bFLEX|STAND|\bKIT\b|STRAP|EXPANSION|THERMOCOUPLE|ANODE|ELEMENT|THERMOSTAT|DRAIN|BLANKET|TOILET|FLUSH|\bGPF\b/i,
};

/* ───────────── web app ───────────── */

function doPost(e) {
  let p = {};
  try { p = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (_) { p = e.parameter || {}; }
  return jsonOut_(jiAction_(p));
}
function doGet() { return ContentService.createTextOutput('HCP Job Inputs web app is running.'); }

function jiAction_(p) {
  try {
    const who = whoIs_(p.token);
    switch (p.action) {
      case 'init':    return Object.assign({ ok: true }, jiInit_(who));
      case 'preview': return Object.assign({ ok: true }, jiPlan_(jiCleanLines_(p.lines), {}));
      case 'apply':   return jiApply_(p, who);
      default:        throw new Error('Unknown action.');
    }
  } catch (err) {
    console.log('jobinputs ' + p.action + ' ❌ ' + err.message);
    return { ok: false, error: err.message };
  }
}
function jsonOut_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function jiInit_(who) {
  const id = props_().getProperty('JI_SHEET_ID');
  const pend = jiPendingRows_();
  return { who: who, sheet_url: id ? 'https://docs.google.com/spreadsheets/d/' + id : '', pending: pend.length,
           pending_jobs: Array.from(new Set(pend.map(r => r.line.ref).filter(Boolean))).length };
}

/* ───────────── lines ───────────── */

/** A line as the page sends it: {order, date, po, ref, part, desc, qty, ext, uom, kind, orig, row}. */
function jiCleanLines_(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('No lines in that file.');
  return raw.map(l => {
    const qty = Number(l.qty) || 0, ext = Number(l.ext) || 0;
    const line = { order: String(l.order || '').trim(), date: String(l.date || '').trim(), po: String(l.po || '').trim(),
                   ref: l.ref ? String(l.ref).trim() : '', part: String(l.part || '').trim(), desc: String(l.desc || l.part || '').trim(),
                   qty: qty, ext: ext, uom: String(l.uom || '').trim(), kind: String(l.kind || 'purchase'), orig: String(l.orig || '').trim(), row: Number(l.row) || 0 };
    if (!line.part) throw new Error('A line has no part number (row ' + line.row + ').');
    return line;
  });
}
function jiKey_(l) { return `${l.order}|${l.part.toUpperCase()}|${l.qty}|${l.ext}`; }
function jiIsReturn_(l) { return l.qty < 0 || l.ext < 0; }
function jiMatchOrder_(l) { return l.orig || l.order; }
function jiCents_(l) { const q = Math.abs(l.qty); return q ? Math.round(Math.abs(l.ext) * 100 / q) : 0; }

/* ───────────── the plan ───────────── */

/**
 * Builds the plan for a batch of lines. opts.fromPending = lines came from the Pending tab (don't mark them
 * as "already waiting"). Returns { groups, counts }.
 */
function jiPlan_(lines, opts) {
  opts = opts || {};
  const posted = jiPostedKeys_();
  const pendingKeys = opts.fromPending ? {} : jiPendingKeys_();
  const groups = [];
  const byRef = {};
  const loose = { skipped: [], info: [], flag: [] };

  lines.forEach(l => {
    const key = jiKey_(l);
    if (posted[key]) { loose.skipped.push(jiItem_('skip', l, 'already posted to HCP on ' + posted[key])); return; }
    if (!l.ref) {
      if (l.kind === 'stock') loose.info.push(jiItem_('info', l, 'stock / truck — no job (PO text "' + l.po + '")'));
      else if (l.kind === 'return' || jiIsReturn_(l)) loose.flag.push(jiItem_('flag', l, 'return whose comment doesn’t name a job — type the job number'));
      else loose.flag.push(jiItem_('flag', l, 'no job number in the PO field ("' + l.po + '") — type the job number'));
      return;
    }
    (byRef[l.ref] = byRef[l.ref] || []).push(l);
  });

  // resolve every job number in one go
  const refs = Object.keys(byRef);
  const resolved = refs.length ? jiResolveRefs_(refs) : {};
  const work = [];       // [{ref, job, lines, note}]
  refs.forEach(ref => {
    const r = resolved[ref];
    const ls = byRef[ref];
    if (!r) { groups.push(jiGroup_(ref, null, 'pending', 'job ' + ref + ' isn’t in HCP yet (looked through the ' + JI.JOB_SCAN_PAGES * 100 + ' most recent jobs) — saved; retried every morning', ls.map(l => jiItem_('pending', l, 'waiting for the job to appear')))); return; }
    if (r.segments) {
      // several 49040-N jobs: each line goes to the segment scheduled closest to its ship date
      const buckets = {};
      ls.forEach(l => {
        const pick = jiPickSegment_(r.segments, l.date);
        if (!pick.job) { groups.push(jiGroup_(ref, null, 'flag', `job ${ref} has segments ${r.segments.map(j => j.invoice_number).join(', ')} — ${pick.why}; type the full job number`, [jiItem_('flag', l, 'which segment?')])); return; }
        const inv = String(pick.job.invoice_number);
        (buckets[inv] = buckets[inv] || { job: pick.job, lines: [], note: pick.why }).lines.push(l);
      });
      Object.keys(buckets).forEach(inv => work.push({ ref: inv, job: buckets[inv].job, lines: buckets[inv].lines, note: 'auto-picked segment: ' + buckets[inv].note }));
      return;
    }
    work.push({ ref: ref, job: r.job, lines: ls, note: r.note || '', fresh: !!r.fresh });
  });

  work.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  work.forEach(w => { try { groups.push(jiPlanJob_(w)); } catch (e) { groups.push(jiGroup_(w.ref, jiJobOut_(w.job), 'pending', 'HCP error: ' + e.message + ' — saved; retried every morning', w.lines.map(l => jiItem_('pending', l, 'retry')))); } });

  // lines already sitting in the Pending tab from an earlier upload: say so (they're saved once, never twice)
  groups.forEach(g => g.items.forEach(it => { if ((it.k === 'pending' || it.k === 'held') && it.keys.some(k => pendingKeys[k])) it.reason += ' — already saved from an earlier upload'; }));

  if (loose.flag.length) groups.push(jiGroup_('', null, 'flag', 'lines with no job number', loose.flag));
  if (loose.info.length) groups.push(jiGroup_('', null, 'info', 'not for a job', loose.info));
  if (loose.skipped.length) groups.push(jiGroup_('', null, 'skipped', 'already posted earlier', loose.skipped));

  const counts = {};
  groups.forEach(g => g.items.forEach(it => { counts[it.k] = (counts[it.k] || 0) + 1; }));
  return { groups: groups, counts: counts };
}

function jiGroup_(ref, job, state, reason, items) { return { ref: ref, job: job, state: state, reason: reason || '', items: items || [] }; }
function jiItem_(k, l, reason, extra) {
  const cents = jiCents_(l);
  return Object.assign({ k: k, use: k === 'add' || k === 'net', order: l.order, date: l.date, part: l.part, name: l.desc, qty: l.qty, cents: cents,
                         total: Math.round(l.qty * cents), reason: reason || '', keys: [jiKey_(l)], line: l }, extra || {});
}
function jiJobOut_(j) {
  if (!j) return null;
  const c = j.customer || {}, s = j.schedule || {};
  return { id: j.id, number: String(j.invoice_number || ''), customer: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || '(no name)',
           status: j.work_status || '', scheduled: s.scheduled_start ? Utilities.formatDate(jiParse_(s.scheduled_start), jiTz_(), 'MM/dd/yy') : '', tags: jiTags_(j) };
}

/** One job's lines → group with add / net / skip / held / warranty / flag items. */
function jiPlanJob_(w) {
  const job = w.fresh ? w.job : hcp_('get', '/jobs/' + encodeURIComponent(w.job.id));   // status and tags as of right now
  const ref = w.ref, lines = w.lines;
  const out = jiJobOut_(job);
  const status = String(job.work_status || '').toLowerCase();
  if (JI.CANCELED.indexOf(status) !== -1) return jiGroup_(ref, out, 'flag', 'job is canceled in HCP — decide by hand', lines.map(l => jiItem_('flag', l, 'job canceled')));
  if (JI.COMPLETED.indexOf(status) === -1) return jiGroup_(ref, out, 'pending', `job isn’t finished yet (HCP status "${job.work_status}") — saved; posts automatically once it’s complete`, lines.map(l => jiItem_('pending', l, 'waiting for the job to be completed')));

  const netted = jiNetAndMerge_(lines);
  let items = netted.items, unmatched = netted.unmatched;
  const result = netted.zeroed.map(z => jiItem_('skip', z.line, 'bought and returned in this file — nets to zero, nothing to post', { order: z.order, qty: z.qty, cents: z.cents, total: 0, keys: z.lines.map(jiKey_) }));

  // manufacturer-warranty jobs: leave the heater unit off (only when WARRANTY_TAGS is set)
  const wtag = jiWarrantyTag_(out.tags);
  if (wtag) {
    items = items.filter(it => { const why = jiWarrantySkip_(it.desc); if (why) result.push(jiItem_('warranty', it.line, `job tagged "${wtag}": ${why}`, { qty: it.qty, cents: it.cents, order: it.order })); return !why; });
    unmatched = unmatched.filter(rt => { const why = jiWarrantySkip_(rt.desc); if (why) result.push(jiItem_('warranty', rt.line, `job tagged "${wtag}": return of a warranty unit that was never added`, { qty: -rt.qty, cents: rt.cents, order: rt.order })); return !why; });
  }

  const existing = (hcp_('get', `/jobs/${job.id}/job_input_materials`) || {}).job_input_materials || [];
  const idx = jiIndexExisting_(existing);
  const adds = [];

  items.forEach(it => {
    const k = it.order + '|' + it.part.toUpperCase();
    const keys = it.lines.map(jiKey_);
    const base = { order: it.order, date: it.line.date, part: it.part, name: it.desc, qty: it.qty, cents: it.cents, total: Math.round(it.qty * it.cents), keys: keys, line: it.line };
    if (idx.tagged[k]) { result.push(Object.assign(jiItem_('skip', it.line, `already on this job (Weinstein #${it.order}, qty ${idx.tagged[k].quantity})`), base)); return; }
    const legacy = (idx.byPart[it.part.toUpperCase()] || []).filter(e => !JI.TAG_RE.test(e.description || '') && Number(e.unit_cost || 0) === it.cents && Math.abs(Number(e.quantity || 0) - it.qty) < 0.001);
    if (legacy.length) { result.push(Object.assign(jiItem_('skip', it.line, 'an untagged entry with the same part / qty / cost is already on the job (older upload)'), base)); return; }
    const payload = jiMakeInput_(it);
    const dup = jiDupReason_(it, idx.byPart, adds);
    if (dup) { result.push(Object.assign(jiItem_('held', it.line, dup), base, { use: false, payload: payload })); return; }
    const item = Object.assign(jiItem_('add', it.line, w.note || ''), base, { payload: payload });
    adds.push(item); result.push(item);
  });

  unmatched.forEach(rt => {
    const k = rt.order + '|' + rt.part.toUpperCase();
    let target = idx.tagged[k], how = 'same order #';
    if (!target) { const c = idx.byPart[rt.part.toUpperCase()] || []; if (c.length === 1) { target = c[0]; how = 'part # only (different order #)'; } }
    const base = { order: rt.order, date: rt.line.date, part: rt.part, name: rt.desc, qty: -rt.qty, cents: rt.cents, total: -Math.round(rt.qty * rt.cents), keys: rt.lines.map(jiKey_), line: rt.line };
    if (!target) { result.push(Object.assign(jiItem_('flag', rt.line, 'return with no purchase of this part in the file or on the HCP job'), base)); return; }
    const newQty = Math.max(Math.round((Number(target.quantity || 0) - rt.qty) * 100) / 100, 0);
    const upd = { uuid: target.uuid, name: target.name, description: target.description, part_number: target.part_number, unit_cost: Number(target.unit_cost || 0), quantity: newQty };
    if (newQty === 0) upd.name = String(upd.name || rt.part).slice(0, 100) + ' (RETURNED)';
    result.push(Object.assign(jiItem_('net', rt.line, `return netted against the HCP entry (${how}): qty ${target.quantity} → ${newQty}`), base, { payload: upd, old_qty: target.quantity }));
  });

  const state = result.some(it => it.k === 'add' || it.k === 'net' || it.k === 'held') ? 'ready' : 'skipped';
  return jiGroup_(ref, out, state, w.note || '', result);
}

/** Net returns against purchases with the same (original order #, part), merge same (order, part, unit cost). */
function jiNetAndMerge_(lines) {
  const groups = {};
  lines.forEach(l => { const k = jiMatchOrder_(l) + '|' + l.part.toUpperCase(); (groups[k] = groups[k] || []).push(l); });
  const items = [], unmatched = [], zeroed = [];
  Object.keys(groups).forEach(k => {
    const grp = groups[k], order = jiMatchOrder_(grp[0]);
    const purchases = grp.filter(l => !jiIsReturn_(l)), returns = grp.filter(jiIsReturn_);
    let retQty = returns.reduce((s, l) => s + Math.abs(l.qty), 0);
    const byCost = {};
    purchases.forEach(l => { const c = jiCents_(l); (byCost[c] = byCost[c] || { qty: 0, bought: 0, line: l, lines: [] }); byCost[c].qty += l.qty; byCost[c].bought += l.qty; byCost[c].lines.push(l); });
    Object.keys(byCost).map(Number).sort((a, b) => b - a).forEach(c => { if (retQty <= 0) return; const take = Math.min(byCost[c].qty, retQty); byCost[c].qty -= take; retQty -= take; if (take > 0) byCost[c].lines = byCost[c].lines.concat(returns); });
    Object.keys(byCost).forEach(c => {
      const b = byCost[c], item = { line: b.line, lines: b.lines, order: order, part: b.line.part, qty: Math.round(b.qty * 100) / 100, cents: Number(c), desc: b.line.desc };
      if (b.qty > 0) items.push(item); else zeroed.push(Object.assign(item, { qty: Math.round(b.bought * 100) / 100 }));
    });
    if (retQty > 0 && returns.length) unmatched.push({ line: returns[0], lines: returns, order: order, part: returns[0].part, qty: Math.round(retQty * 100) / 100, cents: jiCents_(returns[0]), desc: returns[0].desc });
  });
  return { items: items, unmatched: unmatched, zeroed: zeroed };
}

function jiIndexExisting_(existing) {
  const tagged = {}, byPart = {};
  existing.forEach(e => {
    const part = String(e.part_number || '').trim().toUpperCase();
    const m = JI.TAG_RE.exec(e.description || '');
    if (m && part) tagged[m[1] + '|' + part] = e;
    if (part) (byPart[part] = byPart[part] || []).push(e);
  });
  return { tagged: tagged, byPart: byPart };
}

function jiMakeInput_(it) {
  let desc = 'Weinstein #' + it.order; if (it.line.date) desc += ' ' + it.line.date;
  let name = (it.desc || it.part).slice(0, 120);
  if (name.toUpperCase().indexOf(it.part.toUpperCase()) === -1) name = (it.part + ' ' + name).slice(0, 120);
  return { name: name, description: desc, part_number: it.part, unit_cost: Math.round(it.cents), quantity: Number(it.qty) };
}

function jiDupReason_(it, byPart, queued) {
  const part = it.part.toUpperCase();
  if (Math.round(it.qty * it.cents) < JI.DUP_MIN_CENTS) return '';
  for (const e of (byPart[part] || [])) {
    if (Number(e.quantity || 0) <= 0) continue;
    return `this part is already on the job’s Job Inputs (${(e.description || e.name || 'existing entry').trim()}, qty ${e.quantity}, $${(Number(e.unit_cost || 0) / 100).toFixed(2)} each) — held; tick "upload anyway" if it really is a second one`;
  }
  const q = queued.filter(a => a.part.toUpperCase() === part)[0];
  if (q) return `the same part is also being added from order ${q.order} in this file — held; tick "upload anyway" if both are right`;
  return '';
}

function jiWarrantyTag_(tags) {
  const want = String(props_().getProperty('WARRANTY_TAGS') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!want.length) return '';
  return (tags || []).filter(t => want.indexOf(String(t).trim().toLowerCase()) !== -1)[0] || '';
}
function jiWarrantySkip_(desc) {
  desc = desc || '';
  return (JI.WH_TANK_RE.test(desc) || (JI.WH_UNIT_RE.test(desc) && !JI.WH_ACCESSORY_RE.test(desc))) ? 'water heater unit (supplied under warranty, not our cost)' : '';
}
function jiTags_(j) { return (j.tags || []).map(t => (t && typeof t === 'object') ? t.name : t).filter(Boolean).map(String); }

/* ───────────── finding jobs ───────────── */

/** ref → {job} | {job, note} | {segments:[jobs]} | null, for every ref at once (one scan of recent jobs). */
function jiResolveRefs_(refs) {
  const props = props_();
  const out = {}, need = [];
  refs.forEach(ref => {
    const id = props.getProperty('job_' + ref);
    if (id) { try { out[ref] = { job: hcp_('get', '/jobs/' + encodeURIComponent(id)), fresh: true }; return; } catch (_) { props.deleteProperty('job_' + ref); } }
    need.push(ref);
  });
  if (!need.length) return out;
  const found = {}, segs = {};
  const can = r => found[r] || (r.indexOf('-') !== -1 && found[r.split('-')[0]]) || (r.indexOf('-') === -1 && segs[r]);
  for (let page = 1; page <= JI.JOB_SCAN_PAGES; page++) {
    const r = hcp_('get', `/jobs?page=${page}&page_size=100&sort_by=created_at&sort_direction=desc`);
    const jobs = r.jobs || [];
    jobs.forEach(j => { const inv = String(j.invoice_number || '').trim(); if (!inv) return; found[inv] = j; const base = inv.split('-')[0]; if (base !== inv) (segs[base] = segs[base] || []).push(j); });
    if (!jobs.length || page >= (r.total_pages || 0)) break;
    if (need.every(can)) break;
  }
  need.forEach(r => {
    const base = r.split('-')[0];
    if (found[r]) { out[r] = { job: found[r] }; props.setProperty('job_' + r, found[r].id); }
    else if (r !== base && found[base]) out[r] = { job: found[base], note: `job ${r} not found — used ${base}` };
    else if (r === base && segs[r]) out[r] = segs[r].length === 1 ? { job: segs[r][0], note: `only segment ${segs[r][0].invoice_number} exists — used it` } : { segments: segs[r] };
    else out[r] = null;
  });
  return out;
}

function jiPickSegment_(segments, shipDate) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(shipDate || '').trim());
  if (!m) return { job: null, why: 'no usable ship date on the line' };
  const od = Date.UTC(+m[3], +m[1] - 1, +m[2]);
  let best = null, gap = null, why = 'segments have no schedule dates';
  segments.forEach(j => {
    const ss = String((j.schedule || {}).scheduled_start || '').slice(0, 10);
    if (!ss) return;
    const sd = Date.UTC(+ss.slice(0, 4), +ss.slice(5, 7) - 1, +ss.slice(8, 10));
    const g = Math.abs(Math.round((sd - od) / 86400000));
    if (gap === null || g < gap) { best = j; gap = g; why = `${j.invoice_number} scheduled ${ss.slice(5, 7)}/${ss.slice(8, 10)}, order shipped ${m[1]}/${m[2]} (${g}d)`; }
  });
  return { job: best, why: why };
}

/* ───────────── apply ───────────── */

function jiApply_(p, who) {
  const reqId = String(p.req_id || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (reqId) { const prior = jiRecall_(reqId); if (prior) return prior; }
  const result = withLock_(() => jiApplyLocked_(p, who));
  if (reqId && result.ok) jiRemember_(reqId, result);
  return result;
}

function jiApplyLocked_(p, who) {
  const groups = Array.isArray(p.groups) ? p.groups : [];
  const results = [];
  let posted = 0, netted = 0, failed = 0;
  groups.forEach(g => {
    const jobId = String(g.job_id || '');
    const items = (g.items || []).filter(it => it && it.use && it.payload && (it.k === 'add' || it.k === 'net' || it.k === 'held'));
    if (!jobId || !items.length) return;
    try {
      // safety: never add an order+part that is already tagged on the job (another browser tab, a double click…)
      const existing = (hcp_('get', `/jobs/${encodeURIComponent(jobId)}/job_input_materials`) || {}).job_input_materials || [];
      const idx = jiIndexExisting_(existing);
      const send = items.filter(it => it.k === 'net' || !idx.tagged[it.order + '|' + String(it.part).toUpperCase()]);
      if (send.length) hcp_('put', `/jobs/${encodeURIComponent(jobId)}/job_input_materials/bulk_update`, { job_input_materials: send.map(it => it.payload) });
      const when = new Date();
      const rows = send.map(it => [when, who, g.ref || '', g.customer || '', it.order, it.part, it.qty, Number(it.cents || 0) / 100, it.payload.name || '', it.k === 'net' ? 'return netted' : 'added', jobId, (it.keys || []).join(' ; ')]);
      jiAppendRows_('Posted', rows);
      send.forEach(it => { if (it.k === 'net') netted++; else posted++; });
      results.push({ ref: g.ref, ok: true, count: send.length, skipped: items.length - send.length });
      console.log(`jobinputs ✅ job ${g.ref}: ${send.length} line(s) by ${who}`);
    } catch (e) {
      failed++;
      results.push({ ref: g.ref, ok: false, error: e.message });
      console.log(`jobinputs ❌ job ${g.ref}: ${e.message}`);
    }
  });

  // lines for jobs that aren't finished / found yet: keep them, retryPending() posts them when the job completes
  const saved = (Array.isArray(p.pending) && p.pending.length) ? jiSavePending_(jiCleanLines_(p.pending), who, p.pending_reasons || {}) : 0;

  const postedAll = jiPostedKeys_(true);
  const msg = [`✅ Posted ${posted} line${posted === 1 ? '' : 's'}` + (netted ? ` and netted ${netted} return${netted === 1 ? '' : 's'}` : ''),
               saved ? `saved ${saved} line${saved === 1 ? '' : 's'} for jobs that aren’t finished yet (they post automatically)` : '',
               failed ? `${failed} job${failed === 1 ? '' : 's'} failed — see below` : ''].filter(Boolean).join('; ') + '.';
  return { ok: true, message: msg, posted: posted, netted: netted, saved: saved, failed: failed, results: results, posted_total: Object.keys(postedAll).length };
}

/* ───────────── pending (sheet) + morning retry ───────────── */

function jiSavePending_(lines, who, reasons) {
  const have = jiPendingKeys_(), posted = jiPostedKeys_();
  const rows = [];
  lines.forEach(l => {
    const key = jiKey_(l);
    if (have[key] || posted[key]) return;
    have[key] = 'saved';
    rows.push([new Date(), who, l.ref, l.order, l.date, l.po, l.part, l.desc, l.qty, l.ext, l.uom, l.kind, l.orig, String(reasons[key] || reasons[l.ref] || 'waiting'), key]);
  });
  if (rows.length) jiAppendRows_('Pending', rows);
  CacheService.getScriptCache().remove('ji_pending_keys');
  return rows.length;
}

/** Every Pending row as {rowIndex, line, reason}. */
function jiPendingRows_() {
  const sh = jiSheet_('Pending');
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, JI.PENDING_HEADERS.length).getValues();
  return v.map((r, i) => ({ rowIndex: i + 2, added: r[0], by: r[1], reason: String(r[13] || ''), key: String(r[14] || ''),
    line: { ref: String(r[2] || ''), order: String(r[3] || ''), date: String(r[4] || ''), po: String(r[5] || ''), part: String(r[6] || ''), desc: String(r[7] || ''), qty: Number(r[8]) || 0, ext: Number(r[9]) || 0, uom: String(r[10] || ''), kind: String(r[11] || 'purchase'), orig: String(r[12] || ''), row: 0 } })).filter(r => r.line.part);
}
function jiPendingKeys_() {
  const cache = CacheService.getScriptCache();
  const c = cache.get('ji_pending_keys'); if (c) { try { return JSON.parse(c); } catch (_) {} }
  const out = {};
  jiPendingRows_().forEach(r => { out[r.key || jiKey_(r.line)] = r.reason || 'waiting'; });
  try { cache.put('ji_pending_keys', JSON.stringify(out), 300); } catch (_) {}
  return out;
}
function jiPostedKeys_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const c = cache.get('ji_posted_keys'); if (c) { try { return JSON.parse(c); } catch (_) {} } }
  const out = {};
  const sh = jiSheet_('Posted');
  if (sh && sh.getLastRow() >= 2) {
    const v = sh.getRange(2, 1, sh.getLastRow() - 1, JI.POSTED_HEADERS.length).getValues();
    v.forEach(r => { const when = (r[0] && typeof r[0].getTime === 'function') ? Utilities.formatDate(r[0], jiTz_(), 'MM/dd/yy') : String(r[0]); String(r[11] || '').split(' ; ').forEach(k => { if (k) out[k] = when; }); });
  }
  try { cache.put('ji_posted_keys', JSON.stringify(out), 300); } catch (_) {}
  return out;
}

/** Morning job: re-plan every Pending line, post what's ready, keep the rest with an updated reason. */
function retryPending() {
  const rows = jiPendingRows_();
  if (!rows.length) { console.log('Nothing pending.'); return; }
  const plan = jiPlan_(rows.map(r => r.line), { fromPending: true });
  const groups = plan.groups.filter(g => g.state === 'ready' && g.job).map(g => ({ job_id: g.job.id, ref: g.job.number, customer: g.job.customer, items: g.items.filter(it => it.use && it.payload) })).filter(g => g.items.length);
  const res = groups.length ? withLock_(() => jiApplyLocked_({ groups: groups }, 'morning retry')) : { posted: 0, netted: 0, failed: 0, results: [] };

  // what got posted (or was already posted) leaves the Pending tab; everything else gets its current reason
  const posted = jiPostedKeys_(true);
  const reasonByKey = {};
  plan.groups.forEach(g => g.items.forEach(it => (it.keys || []).forEach(k => { reasonByKey[k] = (g.job ? `job ${g.job.number}: ` : '') + (it.k === 'add' || it.k === 'net' ? 'ready' : it.reason || g.reason || it.k); })));
  const sh = jiSheet_('Pending');
  const keep = [], gone = [], attention = [];
  rows.forEach(r => {
    const key = r.key || jiKey_(r.line);
    if (posted[key]) { gone.push(r); return; }
    const reason = reasonByKey[key] || r.reason;
    keep.push(r);
    if (sh && reason !== r.reason) sh.getRange(r.rowIndex, 14).setValue(reason);
    if (/held|flag|canceled|which segment|type the job/.test(reason)) attention.push(`job ${r.line.ref || '?'} · order ${r.line.order} · ${r.line.part} × ${r.line.qty}: ${reason}`);
  });
  if (sh && gone.length) gone.map(r => r.rowIndex).sort((a, b) => b - a).forEach(i => sh.deleteRow(i));
  CacheService.getScriptCache().remove('ji_pending_keys');

  const summary = `Job Inputs retry: posted ${res.posted} line(s), netted ${res.netted}, ${keep.length} still waiting, ${attention.length} need attention.`;
  console.log(summary);
  const to = props_().getProperty('REPORT_TO');
  if (to && (res.posted || res.netted || res.failed)) {
    const lines = [summary, ''];
    res.results.forEach(r => lines.push(r.ok ? `✅ Job ${r.ref}: ${r.count} line(s) posted` : `❌ Job ${r.ref}: ${r.error}`));
    if (attention.length) { lines.push('', 'Needs attention (open the Job Inputs page or the sheet):'); attention.forEach(a => lines.push('  • ' + a)); }
    lines.push('', 'Sheet: https://docs.google.com/spreadsheets/d/' + props_().getProperty('JI_SHEET_ID'));
    GmailApp.sendEmail(to, `Job Inputs — ${res.posted + res.netted} line(s) posted this morning`, lines.join('\n'), { cc: props_().getProperty('REPORT_CC') || '', name: 'Golden Rule Job Inputs' });
  }
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'retryPending').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('retryPending').timeBased().everyDays(1).atHour(6).create();
  console.log('✅ retryPending() runs every morning between 6 and 7 AM.');
}

/* ───────────── sheet, dedupe memory, access, HCP client ───────────── */

function jiAppendRows_(tab, rows) {
  if (!rows.length) return;
  const sh = jiSheet_(tab);
  if (!sh) throw new Error('No sheet yet — run setupSheet() in the HCP Job Inputs script.');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  CacheService.getScriptCache().remove(tab === 'Posted' ? 'ji_posted_keys' : 'ji_pending_keys');
}
function jiSheet_(tab) {
  const id = props_().getProperty('JI_SHEET_ID');
  if (!id) return null;
  try { return SpreadsheetApp.openById(id).getSheetByName(tab); } catch (_) { return null; }
}
function jiRecall_(rid) {
  const c = CacheService.getScriptCache().get('ji_req_' + rid);
  if (c) { try { return JSON.parse(c); } catch (_) {} }
  const v = props_().getProperty('ji_req_' + rid);
  try { return v ? JSON.parse(v).r : null; } catch (_) { return null; }
}
function jiRemember_(rid, result) {
  try { CacheService.getScriptCache().put('ji_req_' + rid, JSON.stringify(Object.assign({}, result, { replay: true })), 21600); } catch (_) {}
  try {
    const props = props_();
    props.setProperty('ji_req_' + rid, JSON.stringify({ t: Date.now(), r: { ok: true, message: result.message, replay: true, posted: result.posted, netted: result.netted, saved: result.saved, failed: result.failed, results: result.results } }));
    const old = Date.now() - 3 * 86400000;
    const all = props.getProperties();
    Object.keys(all).forEach(k => { if (k.indexOf('ji_req_') !== 0) return; let t = 0; try { t = JSON.parse(all[k]).t; } catch (_) {} if (!t || t < old) props.deleteProperty(k); });
  } catch (_) {}
}
function jiTz_() { return Session.getScriptTimeZone() || 'America/New_York'; }
function jiParse_(s) {
  if (s instanceof Date) return s;
  s = String(s || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

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
    const res = UrlFetchApp.fetch(JI.BASE + path, opts);
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) { const h = res.getHeaders(); const wait = Number(h['Retry-After'] || h['retry-after'] || (attempt + 1) * 2); Utilities.sleep(Math.min(Math.max(wait, 1), 10) * 1000); continue; }
    const text = res.getContentText();
    if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
    throw new Error(`HCP ${method.toUpperCase()} ${path.split('?')[0]} → ${code}: ${text.slice(0, 200)}`);
  }
  throw new Error('HCP kept answering busy — gave up after retries.');
}
function props_() { return PropertiesService.getScriptProperties(); }
function apiKey_() { const k = props_().getProperty('HCP_API_KEY'); if (!k) throw new Error('Script property HCP_API_KEY is not set.'); return k; }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Busy — someone else is applying right now. Try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ───────────── setup & checks (run from the editor) ───────────── */

function setupSheet() {
  let id = props_().getProperty('JI_SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (_) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create(JI.SHEET_NAME); id = ss.getId(); props_().setProperty('JI_SHEET_ID', id); }
  [['Posted', JI.POSTED_HEADERS], ['Pending', JI.PENDING_HEADERS]].forEach(([name, headers]) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); sh.getRange(1, 1, 1, headers.length).setFontWeight('bold'); }
  });
  const first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' && ss.getSheets().length > 1) ss.deleteSheet(first);
  console.log(`✅ Sheet ready: ${ss.getUrl()}`);
}

/** Read-only check. */
function verifyAccess() {
  const id = props_().getProperty('JI_SHEET_ID');
  console.log(id ? '✅ Sheet: https://docs.google.com/spreadsheets/d/' + id : '❌ No sheet yet — run setupSheet().');
  const r = hcp_('get', '/jobs?page=1&page_size=1&sort_by=created_at&sort_direction=desc');
  const j = (r.jobs || [])[0];
  console.log(`✅ Jobs readable — ${r.total_items} total; newest #${j ? j.invoice_number : 'n/a'} (${j ? j.work_status : ''})`);
  if (j) { const m = hcp_('get', `/jobs/${j.id}/job_input_materials`); console.log(`✅ Job Inputs readable — newest job has ${(m.job_input_materials || []).length} input(s)`); }
  console.log(`✅ Access codes for ${Object.keys(techCodes_()).length} people`);
  console.log(props_().getProperty('REPORT_TO') ? `✅ Morning summary → ${props_().getProperty('REPORT_TO')}` : '⚠️ REPORT_TO not set — retryPending() will only log.');
  console.log(props_().getProperty('WARRANTY_TAGS') ? `Warranty tags: ${props_().getProperty('WARRANTY_TAGS')}` : 'Warranty skip: off (set WARRANTY_TAGS to turn on)');
  console.log(`Time zone: ${jiTz_()} (should be America/New_York)`);
  console.log(ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'retryPending') ? '✅ Morning retry installed.' : '⚠️ Run installDailyTrigger() so pending lines post themselves.');
}
