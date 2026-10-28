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
 *   • Inventory / truck / shop stock POs ("Inventory", "TRUCK STOCK", "Truck Restock", "shop stock"…) go to the
 *     MONTHLY job on the customer "Inventory Management" (property INVENTORY_CUSTOMER): the customer's job whose
 *     scheduled (or created) date is in the order's ship month. Nothing to edit each month — just create the
 *     month's job in HCP. These post even while that job is still open, and the $100 duplicate-part hold is off
 *     for them. A stock return nets against this month's inventory job, or last month's if it was bought there.
 *   • Receipts from other vendors (Amazon, Home Depot, SupplyHouse… as a PDF, photo, Word .docx or Excel .xlsx) are read by Claude
 *     Haiku (property ANTHROPIC_API_KEY) into the same line shape and follow the same rules. Sales tax shown on
 *     the receipt (and any freight / shipping charge) is spread across the lines so the posted cost is what was actually paid. Dedupe tag becomes
 *     "<Vendor> #<order> <date>". A job number in the receipt's PO field -> that job; anything else (Inventory, Office,
 *     Truck, a tool name, or no PO) -> the month's Inventory Management job. The Amazon Business "Orders" report CSV
 *     is parsed by the page itself (per-item tax, part numbers, duplicate payment rows reconciled) - no Claude needed.
 *
 * ───────────── ONE-TIME SETUP ─────────────
 *  1. script.google.com → New project "HCP Job Inputs" → paste this file (owner: golden.rule.calendar@gmail.com).
 *  2. Project Settings → "Show appsscript.json" → set "timeZone": "America/New_York".
 *  3. Script Properties:  HCP_API_KEY, TECH_CODES (same as the other tools), REPORT_TO (office email for the
 *     morning summary when the retry posts something).  Optional: WARRANTY_TAGS = Bradford White Warranty
 *     (comma-separated job tags whose water-heater UNIT should be left off; empty = off, same as the old config).
 *     Inventory routing: INVENTORY_CUSTOMER (default "Inventory Management"; set to "off" to go back to just
 *     logging stock lines), INVENTORY_CUSTOMER_ID (optional — pins the HCP customer id if the name search is
 *     ambiguous), INVENTORY_START = 2026-10 (stock shipped before this month is only logged, not posted).
 *     Override one month's job from the page ("Use this job") or with property INV_2026-11 = <job #>.
 *     If the Script properties page is read-only ("more than 50 properties"), run cleanupProperties() once.
 *  4. Run setupSheet() → creates the "Job Inputs Uploads" spreadsheet (Posted + Pending tabs) and saves its ID.
 *  5. Run verifyAccess() (read-only). Run installDailyTrigger() once (retryPending every morning 6–7 AM).
 *  6. Deploy → Web app (Execute as Me, Anyone) → URL into config.js as "jobInputs".
 *
 * Actions (POST JSON, all need "token"):
 *   init     {}                         → who, sheet url, pending count
 *   preview  {lines:[…]}                → plan: groups per job with add / net / skip / held / flag items
 *   apply    {req_id, groups:[{job_id, ref, items:[…]}], pending:[lines]} → posts, logs, saves pending
 *   receipt  {name, mime, data(base64)}   → lines parsed from a vendor receipt (PDF / image / .docx / .xlsx), ready for preview
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
  TAG_RE: /^\s*(?:[A-Za-z][A-Za-z0-9 .&'-]{0,40}?)\s*#\s*([A-Za-z0-9.\-/]+)/,   // "Weinstein #S039… 10/02/2026", "Amazon #112-… 10/19/2026"
  CLAUDE_MODEL: 'claude-haiku-5-5',
  RECEIPT_MAX_BYTES: 8 * 1024 * 1024,
  INV_PREFIX: 'INV:',            // synthetic ref for stock lines: INV:2026-10 = the Inventory Management job for Oct 2026
  INV_DEFAULT_CUSTOMER: 'Inventory Management',
  INV_DEFAULT_START: '2026-10',
  STOCK_WORDS: ['inventory', 'inventor', 'stock', 'restock', 'truck', 'shop', 'van', 'warehouse'],
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
      case 'receipt': return Object.assign({ ok: true }, jiReceipt_(p, who));
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
                   qty: qty, ext: ext, uom: String(l.uom || '').trim(), kind: String(l.kind || 'purchase'), orig: String(l.orig || '').trim(), row: Number(l.row) || 0,
                   stock: !!l.stock, vendor: String(l.vendor || '').trim(), gen: !!l.gen };
    if (line.orig.indexOf('vendor=') === 0) { line.vendor = line.orig.slice(7); line.orig = ''; }   // how the Pending tab stores the vendor
    if (line.kind === 'return-stock') { line.kind = 'return'; line.stock = true; }      // how the Pending tab stores a stock return
    if (line.kind === 'stock' || (!line.ref && line.kind !== 'return' && jiIsStockPo_(line.po))) line.stock = true;
    if (!line.part) throw new Error('A line has no part number (row ' + line.row + ').');
    return line;
  });
}
function jiKey_(l) { return `${l.order}|${l.part.toUpperCase()}|${l.qty}|${l.ext}`; }
function jiIsStockPo_(po) { const b = String(po || '').trim().replace(/^\s*PO\s*#?\s*/i, '').trim().toLowerCase(); return !!b && JI.STOCK_WORDS.some(w => b.indexOf(w) !== -1); }
function jiInvOn_() { const v = String(props_().getProperty('INVENTORY_CUSTOMER') || JI.INV_DEFAULT_CUSTOMER).trim(); return /^(off|no|none|0|false)$/i.test(v) ? '' : v; }
function jiInvStart_() { return String(props_().getProperty('INVENTORY_START') || JI.INV_DEFAULT_START).trim(); }
function jiInvRef_(shipDate) { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(shipDate || '').trim()); return m ? JI.INV_PREFIX + m[3] + '-' + ('0' + m[1]).slice(-2) : ''; }
function jiInvMonth_(ref) { return String(ref || '').slice(JI.INV_PREFIX.length); }           // 'INV:2026-10' -> '2026-10'
function jiInvLabel_(ref) { const m = jiInvMonth_(ref); const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1)); return isNaN(d) ? ref : Utilities.formatDate(d, 'UTC', 'MMM yyyy') + ' inventory'; }
function jiInvPrev_(ref) { const m = jiInvMonth_(ref); let y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1; if (mo < 1) { mo = 12; y--; } return JI.INV_PREFIX + y + '-' + ('0' + mo).slice(-2); }
function jiIsInvRef_(ref) { return String(ref || '').indexOf(JI.INV_PREFIX) === 0; }
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

  const invName = jiInvOn_(), invStart = jiInvStart_();
  const invRefs = {};        // refs (incl. job numbers typed on the page) whose lines are inventory / truck stock
  lines.forEach(l => {
    const key = jiKey_(l);
    if (posted[key]) { loose.skipped.push(jiItem_('skip', l, 'already posted to HCP on ' + posted[key])); return; }
    if (!l.ref && invName && l.stock) {
      const ref = jiInvRef_(l.date);
      if (!ref) { loose.flag.push(jiItem_('flag', l, 'stock line (PO "' + l.po + '") has no usable ship date — type the job number')); return; }
      if (invStart && jiInvMonth_(ref) < invStart) { loose.info.push(jiItem_('info', l, 'stock / truck shipped before ' + invStart + ' — not posted (PO text "' + l.po + '")')); return; }
      l.ref = ref;
    }
    if (l.ref && l.stock) invRefs[l.ref] = true;
    if (!l.ref) {
      if (l.kind === 'stock') loose.info.push(jiItem_('info', l, 'stock / truck — no job (PO text "' + l.po + '")'));
      else if (l.kind === 'return' || jiIsReturn_(l)) loose.flag.push(jiItem_('flag', l, 'return whose comment doesn’t name a job — type the job number'));
      else loose.flag.push(jiItem_('flag', l, 'no job number in the PO field ("' + l.po + '") — type the job number'));
      return;
    }
    (byRef[l.ref] = byRef[l.ref] || []).push(l);
  });

  // resolve every job number in one go (inventory months through the Inventory Management customer)
  const refs = Object.keys(byRef);
  const invMonths = refs.filter(jiIsInvRef_), jobRefs = refs.filter(r => !jiIsInvRef_(r));
  const resolved = jobRefs.length ? jiResolveRefs_(jobRefs) : {};
  const work = [];       // [{ref, job, lines, note, inv}]
  invMonths.forEach(ref => {
    const ls = byRef[ref], label = jiInvLabel_(ref);
    let r;
    try { r = jiResolveInventory_(ref); } catch (e) { r = { error: e.message }; }
    if (r.job) { work.push({ ref: String(r.job.invoice_number || ref), job: r.job, lines: ls, note: r.note || '', fresh: true, inv: true, label: label, invRef: ref }); return; }
    const why = r.error ? 'HCP error: ' + r.error + ' — saved; retried every morning'
      : r.ambiguous ? `${invName} has several jobs in ${label.replace(' inventory', '')} (${r.ambiguous.join(', ')}) — type the one to use`
      : r.noCustomer ? `no HCP customer named "${invName}" — create it (or set INVENTORY_CUSTOMER_ID); saved; retried every morning`
      : `no ${invName} job in ${label.replace(' inventory', '')} yet — create one in HCP (any day that month); saved; retried every morning`;
    groups.push(Object.assign(jiGroup_(ref, null, r.ambiguous ? 'flag' : 'pending', why, ls.map(l => jiItem_(r.ambiguous ? 'flag' : 'pending', l, r.ambiguous ? 'which job?' : 'waiting for the month’s inventory job'))), { label: label }));
  });
  jobRefs.forEach(ref => {
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
    work.push({ ref: ref, job: r.job, lines: ls, note: r.note || '', fresh: !!r.fresh, inv: !!invRefs[ref], label: invRefs[ref] ? 'inventory (job typed on the page)' : '' });
  });

  work.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  work.forEach(w => { try { jiPlanJob_(w).forEach(g => groups.push(g)); } catch (e) { groups.push(jiGroup_(w.ref, jiJobOut_(w.job), 'pending', 'HCP error: ' + e.message + ' — saved; retried every morning', w.lines.map(l => jiItem_('pending', l, 'retry')))); } });

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

/** One job's lines → [group] with add / net / skip / held / warranty / flag items (plus, for an inventory job, a
 *  second group when a stock return has to be netted on the previous month's inventory job). */
function jiPlanJob_(w) {
  const job = w.fresh ? w.job : hcp_('get', '/jobs/' + encodeURIComponent(w.job.id));   // status and tags as of right now
  const ref = w.ref, lines = w.lines, inv = !!w.inv;
  const out = jiJobOut_(job);
  const tag = g => { if (w.label) g.label = w.label; return [g]; };
  const status = String(job.work_status || '').toLowerCase();
  if (JI.CANCELED.indexOf(status) !== -1) return tag(jiGroup_(ref, out, 'flag', 'job is canceled in HCP — decide by hand', lines.map(l => jiItem_('flag', l, 'job canceled'))));
  if (!inv && JI.COMPLETED.indexOf(status) === -1) return tag(jiGroup_(ref, out, 'pending', `job isn’t finished yet (HCP status "${job.work_status}") — saved; posts automatically once it’s complete`, lines.map(l => jiItem_('pending', l, 'waiting for the job to be completed'))));

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
    const dup = inv ? '' : jiDupReason_(it, idx.byPart, adds);     // stock gets restocked all month — no duplicate hold on the inventory job
    if (dup) { result.push(Object.assign(jiItem_('held', it.line, dup), base, { use: false, payload: payload })); return; }
    const item = Object.assign(jiItem_('add', it.line, w.note || ''), base, { payload: payload });
    adds.push(item); result.push(item);
  });

  const prevGroup = { job: null, out: null, items: [] };     // stock returns that belong on last month's inventory job
  unmatched.forEach(rt => {
    const k = rt.order + '|' + rt.part.toUpperCase();
    let target = idx.tagged[k], how = 'same order #';
    if (!target) { const c = idx.byPart[rt.part.toUpperCase()] || []; if (c.length === 1) { target = c[0]; how = 'part # only (different order #)'; } }
    const base = { order: rt.order, date: rt.line.date, part: rt.part, name: rt.desc, qty: -rt.qty, cents: rt.cents, total: -Math.round(rt.qty * rt.cents), keys: rt.lines.map(jiKey_), line: rt.line };
    let bucket = result;
    if (!target && inv && jiIsInvRef_(w.invRef || '')) {
      // bought on last month's inventory job? look there once
      const pm = jiInvPrevJob_(w.invRef);
      if (pm.job) {
        if (!prevGroup.job) { prevGroup.job = pm.job; prevGroup.out = jiJobOut_(pm.job); prevGroup.idx = jiIndexExisting_((hcp_('get', `/jobs/${pm.job.id}/job_input_materials`) || {}).job_input_materials || []); }
        let t2 = prevGroup.idx.tagged[k]; how = 'same order #, on last month’s inventory job';
        if (!t2) { const c = prevGroup.idx.byPart[rt.part.toUpperCase()] || []; if (c.length === 1) { t2 = c[0]; how = 'part # only, on last month’s inventory job'; } }
        if (t2) { target = t2; bucket = prevGroup.items; }
      }
    }
    if (!target) { result.push(Object.assign(jiItem_('flag', rt.line, 'return with no purchase of this part in the file or on the HCP job' + (inv ? ' (this month’s or last month’s inventory job)' : '')), base)); return; }
    const newQty = Math.max(Math.round((Number(target.quantity || 0) - rt.qty) * 100) / 100, 0);
    const upd = { uuid: target.uuid, name: target.name, description: target.description, part_number: target.part_number, unit_cost: Number(target.unit_cost || 0), quantity: newQty };
    if (newQty === 0) upd.name = String(upd.name || rt.part).slice(0, 100) + ' (RETURNED)';
    bucket.push(Object.assign(jiItem_('net', rt.line, `return netted against the HCP entry (${how}): qty ${target.quantity} → ${newQty}`), base, { payload: upd, old_qty: target.quantity }));
  });

  const state = result.some(it => it.k === 'add' || it.k === 'net' || it.k === 'held') ? 'ready' : 'skipped';
  const groups = tag(jiGroup_(ref, out, state, w.note || '', result));
  if (prevGroup.items.length) groups.push(Object.assign(jiGroup_(String(prevGroup.job.invoice_number || ''), prevGroup.out, 'ready', 'stock returned this month, bought last month', prevGroup.items), { label: jiInvLabel_(jiInvPrev_(w.invRef)) }));
  return groups;
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
  let desc = (it.line.vendor || 'Weinstein') + ' #' + it.order; if (it.line.date) desc += ' ' + it.line.date;
  let name = (it.desc || it.part).slice(0, 120);
  if (!it.line.gen && name.toUpperCase().indexOf(it.part.toUpperCase()) === -1) name = (it.part + ' ' + name).slice(0, 120);   // generated stand-in part #s stay out of the name
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
const JI_RUN = { resolved: {} };     // job lookups remembered for the rest of this execution (found or not)
function jiResolveRefs_(refs) {
  const memo = {}; refs = refs.filter(r => { if (Object.prototype.hasOwnProperty.call(JI_RUN.resolved, r)) { memo[r] = JI_RUN.resolved[r]; return false; } return true; });
  if (!refs.length) return memo;
  const res = jiResolveRefsUncached_(refs);
  Object.keys(res).forEach(r => { JI_RUN.resolved[r] = res[r]; });
  return Object.assign(memo, res);
}
function jiResolveRefsUncached_(refs) {
  const cache = CacheService.getScriptCache();      // job # -> id, kept 6 h (NOT in script properties - those cap at 50 editable rows)
  const out = {}, need = [];
  refs.forEach(ref => {
    const id = cache.get('job_' + ref) || props_().getProperty('job_' + ref);   // old property entries still honoured until cleanupProperties() runs
    if (id) { try { out[ref] = { job: hcp_('get', '/jobs/' + encodeURIComponent(id)), fresh: true }; return; } catch (_) { cache.remove('job_' + ref); } }
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
    if (found[r]) { out[r] = { job: found[r] }; try { cache.put('job_' + r, found[r].id, 21600); } catch (_) {} }
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

/* ───────────── the monthly Inventory Management job ───────────── */

/** The HCP customer id for INVENTORY_CUSTOMER (cached in script properties). '' when not found. */
function jiInvCustomerId_() {
  const props = props_();
  const pinned = String(props.getProperty('INVENTORY_CUSTOMER_ID') || '').trim();
  if (pinned) return pinned;
  const name = jiInvOn_();
  if (!name) return '';
  const cacheKey = 'inv_customer_' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cached = props.getProperty(cacheKey);
  if (cached) return cached;
  const want = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hits = {}, seen = {};
  [name, name.split(/\s+/)[0]].forEach(q => {
    for (let page = 1; page <= 3; page++) {
      const r = hcp_('get', `/customers?q=${encodeURIComponent(q)}&page=${page}&page_size=50`);
      const cs = r.customers || [];
      cs.forEach(c => {
        if (seen[c.id]) return; seen[c.id] = true;
        const names = [[c.first_name, c.last_name].filter(Boolean).join(' '), c.company || '', c.first_name || '', c.last_name || ''];
        if (names.some(n => { const k = String(n).toLowerCase().replace(/[^a-z0-9]/g, ''); return k && (k === want || jiSimilar_(k, want) >= 0.88); })) hits[c.id] = c;
      });
      if (!cs.length || page >= (r.total_pages || 0)) break;
    }
  });
  const ids = Object.keys(hits);
  if (ids.length !== 1) { console.log(`inventory customer "${name}": ${ids.length} match(es)` + (ids.length ? ' — ' + ids.map(i => jiCustName_(hits[i]) + ' (' + i + ')').join(', ') + ' — set INVENTORY_CUSTOMER_ID' : '')); return ''; }
  props.setProperty(cacheKey, ids[0]);
  return ids[0];
}
function jiCustName_(c) { c = c || {}; return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || '(no name)'; }
/** Cheap similarity (tolerates "Managment" vs "Management"): 1 - edit distance / longer length. */
function jiSimilar_(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return 0;
  let prev = []; for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return 1 - prev[n] / Math.max(m, n);
}
/** 'YYYY-MM' a job belongs to: scheduled start (local if given), else created. */
function jiJobMonth_(j) {
  const s = j.schedule || {};
  const v = [s.scheduled_start_local, s.scheduled_start, j.created_at].find(x => x && String(x).length >= 7);
  return v ? String(v).slice(0, 7) : '';
}
/** Every job on the inventory customer, grouped by month (one HCP listing per request, cached 10 min). */
function jiInvJobsByMonth_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const c = cache.get('inv_jobs_by_month'); if (c) { try { return JSON.parse(c); } catch (_) {} } }
  const cid = jiInvCustomerId_();
  if (!cid) return null;
  const by = {};
  for (let page = 1; page <= 10; page++) {
    const r = hcp_('get', `/jobs?customer_id=${encodeURIComponent(cid)}&page=${page}&page_size=100&sort_by=created_at&sort_direction=desc`);
    const jobs = r.jobs || [];
    jobs.forEach(j => { const m = jiJobMonth_(j); if (m) (by[m] = by[m] || []).push(j); });
    if (!jobs.length || page >= (r.total_pages || 0)) break;
  }
  Object.keys(by).forEach(m => { const live = by[m].filter(j => JI.CANCELED.indexOf(String(j.work_status || '').toLowerCase()) === -1); if (live.length) by[m] = live; });
  try { cache.put('inv_jobs_by_month', JSON.stringify(by), 600); } catch (_) {}
  return by;
}
/** 'INV:2026-10' → {job} | {ambiguous:[numbers]} | {noCustomer:true} | {} (no job that month). Property INV_2026-10 = job # pins a month. */
function jiResolveInventory_(ref) {
  const month = jiInvMonth_(ref);
  const pin = String(props_().getProperty('INV_' + month) || '').trim();
  if (pin) { const r = jiResolveRefs_([pin])[pin]; if (r && r.job) return { job: r.job, note: 'pinned by property INV_' + month }; }
  let by = jiInvJobsByMonth_();
  if (by === null) return { noCustomer: true };
  if (!(by[month] || []).length) by = jiInvJobsByMonth_(true) || {};     // maybe the month's job was just created — look again
  const jobs = by[month] || [];
  if (!jobs.length) return {};
  if (jobs.length > 1) return { ambiguous: jobs.map(j => String(j.invoice_number || j.id)) };
  return { job: jobs[0] };
}
function jiInvPrevJob_(ref) { try { const r = jiResolveInventory_(jiInvPrev_(ref)); return r.job ? r : {}; } catch (_) { return {}; } }

/* ───────────── vendor receipts (Amazon, Home Depot…) via Claude ───────────── */

const JI_RECEIPT_PROMPT = `You read purchase receipts / order confirmations / invoices for a plumbing company and return the line items as JSON.
Return ONLY a JSON object, no prose, shaped exactly like:
{"vendor":"Amazon","order":"112-3977429-7899424","order_date":"10/16/2026","ship_date":"10/19/2026","po":"Pat Truck & Inventory",
 "subtotal":130.32,"shipping":0,"tax":7.82,"total":138.14,
 "lines":[{"description":"EZARC Carbide Reciprocating Saw Blades, 6-Inch 8TPI, Thick Metal, 10-Pack","part":"","qty":1,"unit_price":66.47,"line_total":66.47}]}
Rules:
- Read order acknowledgements / confirmations / quotes-turned-orders too, even if they say "NOT AN INVOICE" or "DO NOT PAY" - they still list what was bought.
- Plumbing and drain-cleaning parts with odd descriptions are real items (e.g. ".66 X 2 LEADER" is a drain-machine leader cable, "C-6 CUTTER", "3/8 X 50 CABLE").
- vendor: short store name (Amazon, Home Depot, SupplyHouse, Ferguson, Lowe's, Spartan Tool…). order: the vendor's order / invoice / acknowledgement number.
- Dates as MM/DD/YYYY. ship_date = when it shipped or was picked up / delivered if shown, else "".
- po: the customer PO / job / reference text exactly as printed (Amazon Business "PO number", a "Job" or "Reference" field); "" if none.
- lines: every physical item across ALL shipments / pages, in order. qty is the number of units ("2 of:" = 2). unit_price is per unit before tax; line_total = qty x unit_price. Do not include tax, discounts, gift cards, subscriptions, or returns as lines.
- Freight / shipping / delivery / handling / fuel surcharge charges are NOT lines, even when printed as a row in the item table: add them all up into "shipping".
- part: a model / SKU / item number if printed next to the item, else "".
- subtotal / shipping / tax / total: numbers from the receipt (0 when not shown). tax is the sales tax actually charged for the whole order; shipping is every freight / shipping / handling charge.
- Numbers are plain numbers (no $ or commas). Unknown text fields are "". Never invent items.`;

function jiReceipt_(p, who) {
  const name = String(p.name || 'receipt'), mime = String(p.mime || '').toLowerCase();
  const data = String(p.data || '');
  if (!data) throw new Error('No file data received.');
  if (data.length * 0.75 > JI.RECEIPT_MAX_BYTES) throw new Error('That file is over 8 MB — take a smaller photo or export the receipt as a PDF.');
  const key = props_().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set in the HCP Job Inputs script properties — needed to read receipts that aren’t Weinstein CSVs.');
  let block;
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data } };
  else if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) block = { type: 'image', source: { type: 'base64', media_type: mime, data: data } };
  else if (/^text\//.test(mime) || /\.(txt|htm|html)$/i.test(name)) block = { type: 'text', text: Utilities.newBlob(Utilities.base64Decode(data)).getDataAsString().slice(0, 60000) };
  else if (/\.docx$/i.test(name) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') block = { type: 'text', text: 'Word document ' + name + ':\n' + jiOfficeText_(data, 'docx') };
  else if (/\.xlsx$/i.test(name) || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') block = { type: 'text', text: 'Excel workbook ' + name + ' (tab-separated, one block per sheet):\n' + jiOfficeText_(data, 'xlsx') };
  else if (/\.(doc|xls)$/i.test(name)) throw new Error('That\u2019s an old-style Office file (.doc / .xls). Open it and Save As .docx / .xlsx or PDF, then upload that.');
  else throw new Error('Receipts can be a PDF, a photo (JPG / PNG), a Word (.docx) or Excel (.xlsx) file, or a text file. Got: ' + (mime || name));

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: JI.CLAUDE_MODEL, max_tokens: 4000, system: JI_RECEIPT_PROMPT,
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'Receipt file: ' + name + '. Return the JSON.' }] }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Could not read the receipt (Claude ' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 160));
  const text = (JSON.parse(res.getContentText()).content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('Could not find any line items on that receipt.');
  let r; try { r = JSON.parse(m[0]); } catch (_) { throw new Error('The receipt reader returned something unreadable — try again or use a clearer file.'); }
  const lines = jiReceiptLines_(r, name);
  if (!lines.length) throw new Error('No purchasable items found on that receipt.');
  console.log(`jobinputs receipt ${r.vendor || '?'} #${r.order || '?'} PO "${r.po || ''}": ${lines.length} line(s), tax ${r.tax || 0}, shipping ${r.shipping || 0}, by ${who}`);
  return { lines: lines, vendor: lines[0].vendor, order: lines[0].order, date: lines[0].date, po: lines[0].po, tax: Number(r.tax) || 0, shipping: Number(r.shipping) || 0, total: Number(r.total) || 0 };
}

/** .docx / .xlsx (both are zip files of XML) → plain text for the receipt reader. Tables keep their rows / columns. */
function jiOfficeText_(b64, kind) {
  let files;
  try { files = Utilities.unzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/zip', 'f.zip')); }
  catch (e) { throw new Error('Couldn\u2019t open that ' + (kind === 'docx' ? 'Word' : 'Excel') + ' file \u2014 is it password-protected or damaged? Try saving it as a PDF.'); }
  const byName = {}; files.forEach(f => { byName[f.getName()] = f.getDataAsString('UTF-8'); });
  const text = kind === 'docx' ? jiDocxText_(byName) : jiXlsxText_(byName);
  if (!text.replace(/\s/g, '')) throw new Error('No text found in that file. If it\u2019s a scanned receipt pasted in as a picture, upload the picture or a PDF instead.');
  return text.slice(0, 60000);
}
function jiXmlDecode_(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
}
/** Word: body + headers/footers; paragraphs → lines, table cells → tabs, rows → lines. */
function jiDocxText_(byName) {
  const rank = n => /header/.test(n) ? 0 : /document/.test(n) ? 1 : 2;                 // header (vendor name, logo text) → body → footer
  const parts = Object.keys(byName).filter(n => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return parts.map(n => jiXmlDecode_(byName[n]
    .replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '')                       // text boxes are stored twice (new + old format) - keep one copy
    .replace(/<\/w:txbxContent>/g, '\n')
    .replace(/<w:tc[ >][\s\S]*?<\/w:tc>/g, tc => tc.replace(/<\/w:p>/g, ' ').replace(/<w:br[^>]*\/>/g, ' ').replace(/<w:tab\/>/g, ' '))   // a cell's own paragraphs stay in the cell
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \u00a0]+/g, ' ').replace(/ ?\t ?/g, '\t').replace(/\t+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()).filter(Boolean).join('\n\n');
}
/** Excel: every sheet as tab-separated rows (shared strings and inline strings resolved; numbers as stored). */
function jiXlsxText_(byName) {
  const shared = [];
  const ss = byName['xl/sharedStrings.xml'] || '';
  (ss.match(/<si>[\s\S]*?<\/si>/g) || []).forEach(si => shared.push(jiXmlDecode_((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''))));
  const names = {};   // sheetN.xml -> tab name, from workbook.xml + its rels
  const wb = byName['xl/workbook.xml'] || '', rels = byName['xl/_rels/workbook.xml.rels'] || '';
  (wb.match(/<sheet [^>]*>/g) || []).forEach(t => {
    const nm = /name="([^"]*)"/.exec(t), rid = /r:id="([^"]*)"/.exec(t);
    const rel = rid && new RegExp('<Relationship[^>]*Id="' + rid[1] + '"[^>]*>').exec(rels);
    const tgt = rel && /Target="([^"]*)"/.exec(rel[0]);
    if (nm && tgt) names['xl/' + tgt[1].replace(/^\/?xl\//, '')] = jiXmlDecode_(nm[1]);
  });
  const col = ref => { let n = 0; String(ref).replace(/\d+/g, '').toUpperCase().split('').forEach(ch => { n = n * 26 + ch.charCodeAt(0) - 64; }); return n - 1; };
  return Object.keys(byName).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).map(n => {
    const rows = (byName[n].match(/<row[^>]*>[\s\S]*?<\/row>/g) || []).map(r => {
      const cells = [];
      (r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).forEach(c => {
        const ref = /r="([A-Z]+\d+)"/.exec(c), t = /t="([^"]+)"/.exec(c), v = /<v>([\s\S]*?)<\/v>/.exec(c);
        let val = '';
        if (t && t[1] === 's' && v) val = shared[+v[1]] || '';
        else if (t && t[1] === 'inlineStr') val = jiXmlDecode_((c.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(x => x.replace(/<[^>]+>/g, '')).join(''));
        else if (v) val = jiXmlDecode_(v[1]);
        const i = ref ? col(ref[1]) : cells.length;
        while (cells.length < i) cells.push('');
        cells[i] = val.replace(/[\t\r\n]+/g, ' ').trim();
      });
      return cells.join('\t').replace(/\t+$/, '');
    }).filter(r => r.replace(/\t/g, '').trim());
    return rows.length ? '=== Sheet: ' + (names[n] || n.replace(/^.*\//, '')) + ' ===\n' + rows.join('\n') : '';
  }).filter(Boolean).join('\n\n');
}

/** Haiku's JSON → page-shaped lines, with the receipt's sales tax spread across the items by their share of the subtotal. */
function jiReceiptLines_(r, fileName) {
  const vendor = String(r.vendor || 'Receipt').replace(/[#|]/g, '').trim().slice(0, 30) || 'Receipt';
  const order = String(r.order || '').replace(/[\s|]/g, '').trim() || ('file-' + String(fileName).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 24));
  const date = jiMdy_(r.ship_date) || jiMdy_(r.order_date) || '';
  const po = String(r.po || '').trim();
  const items = (Array.isArray(r.lines) ? r.lines : []).map(l => {
    const qty = Math.abs(Number(l.qty) || 0) || 1;
    let total = Number(l.line_total) || 0; const unit = Number(l.unit_price) || 0;
    if (!total && unit) total = unit * qty;
    return { desc: String(l.description || '').replace(/\s+/g, ' ').trim(), part: String(l.part || '').trim(), qty: qty, total: Math.round(total * 100) / 100 };
  }).filter(i => i.desc && i.total > 0);
  const sub = items.reduce((s, i) => s + i.total, 0);
  const tax = Math.max(Number(r.tax) || 0, 0), ship = Math.max(Number(r.shipping) || 0, 0);
  let taxLeft = Math.round((tax + ship) * 100);      // sales tax + freight are spread over the items, so the posted cost is what was paid
  const cls = po ? jiClassifyPo_(po) : { kind: 'stock', ref: '' };
  const seen = {};
  return items.map((i, n) => {
    let add = n === items.length - 1 ? taxLeft : Math.round((tax + ship) * 100 * i.total / (sub || 1));   // cents of tax + freight for this line; last line takes the rounding
    taxLeft -= add;
    const ext = Math.round(i.total * 100 + add) / 100;
    const gen = !i.part;
    let part = i.part || jiPartFromDesc_(vendor, i.desc);
    if (seen[part.toUpperCase()]) part = part + '-' + (n + 1);            // two different items that slug the same
    seen[part.toUpperCase()] = true;
    // on a vendor receipt anything that isn't a job number (Inventory, Office, Truck, a tool, nothing at all) is overhead /
    // stock for the business -> the month's Inventory Management job
    const stock = cls.kind !== 'purchase' && cls.kind !== 'return';
    return { order: order, date: date, po: po, ref: cls.ref, part: part, desc: i.desc, qty: i.qty, ext: ext, uom: 'ea', kind: stock ? 'stock' : cls.kind,
             orig: '', stock: stock, vendor: vendor, row: n + 1, tax_added: add / 100, gen: gen };
  });
}
function jiMdy_(v) {
  v = String(v || '').trim(); if (!v) return '';
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v); if (m) return ('0' + m[1]).slice(-2) + '/' + ('0' + m[2]).slice(-2) + '/' + m[3];
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v); if (m) return m[2] + '/' + m[3] + '/' + m[1];
  const d = new Date(v); return isNaN(d) ? '' : Utilities.formatDate(d, 'UTC', 'MM/dd/yyyy');
}
/** A job number standing on its own ("49652", "Job 49652-2", "PO#49652"), never digits inside another code like "W536961". */
function jiJobRef_(raw) { const m = /(?:^|[^A-Za-z0-9])(\d{4,6})(?:\s*-\s*(\d{1,2}))?(?![A-Za-z0-9])/.exec(String(raw || '')); return m ? (m[2] ? m[1] + '-' + parseInt(m[2], 10) : m[1]) : ''; }
function jiClassifyPo_(t) {
  const body = String(t || '').trim().replace(/^\s*PO\s*#?\s*/i, '').trim(), low = body.toLowerCase();
  if (/^return/.test(low) || low === 'rtn' || /^credit/.test(low)) return { kind: 'return', ref: '' };
  const ref = jiJobRef_(body); if (ref) return { kind: 'purchase', ref: ref };
  if (jiIsStockPo_(body)) return { kind: 'stock', ref: '' };
  return { kind: 'unknown', ref: '' };
}
/** "EZARC Carbide Reciprocating Saw Blades, 6-Inch 8TPI…" → "AMZ-EZARC-CARBIDE-RECIP" — a stable, readable stand-in part number. */
function jiPartFromDesc_(vendor, desc) {
  const prefix = { amazon: 'AMZ', 'home depot': 'HD', lowes: 'LOW', "lowe's": 'LOW', supplyhouse: 'SH', 'supplyhouse.com': 'SH', ferguson: 'FERG', walmart: 'WMT', ebay: 'EBAY', grainger: 'GRNG', zoro: 'ZORO' }[vendor.toLowerCase()]
    || vendor.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'RCPT';
  const stop = /^(the|a|an|of|for|with|and|in|to|x|by|pack|pcs|piece|pieces|set|new|inch|in|ft|feet)$/i;
  const all = desc.split(/[^A-Za-z0-9]+/).filter(w => w && !stop.test(w));
  const words = all.filter(w => /[A-Za-z]{2,}/.test(w)).slice(0, 4);        // real words first ("25 Pack, 9 inch, 14/18 TPI…" → RECIPROCATING-SAW-BLADE)
  const use = (words.length >= 2 ? words : all.slice(0, 4)).map(w => w.toUpperCase().slice(0, 8));
  return (prefix + '-' + (use.join('-') || 'ITEM')).slice(0, 30);
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

  const postedAll = p.no_total ? {} : jiPostedKeys_(true);
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
    const kind = l.stock && l.kind === 'return' ? 'return-stock' : (l.stock ? 'stock' : l.kind);
    const orig = l.orig || (l.vendor ? 'vendor=' + l.vendor : '');
    rows.push([new Date(), who, jiIsInvRef_(l.ref) ? '' : l.ref, l.order, l.date, l.po, l.part, l.desc, l.qty, l.ext, l.uom, kind, orig, String(reasons[key] || reasons[l.ref] || 'waiting'), key]);
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

/**
 * Morning job: re-plan the Pending lines job by job, post what's ready, keep the rest with an updated reason.
 * Works in slices so it never hits Apps Script's 6-minute limit: after ~4 minutes it saves what it has done and
 * schedules retryPendingContinue() a minute later to carry on. The summary email goes out once, when every job
 * has been checked.
 */
function retryPending() { jiRetry_(false); }
function retryPendingContinue() { jiRetry_(true); }

const JI_RETRY = { BUDGET_MS: 4 * 60 * 1000, MAX_RUNS: 15 };

function jiRetry_(isContinue) {
  const started = Date.now(), props = props_();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'retryPendingContinue').forEach(t => ScriptApp.deleteTrigger(t));
  let state = null;
  if (isContinue) { try { state = JSON.parse(props.getProperty('ji_retry_state') || 'null'); } catch (_) { state = null; } }
  if (!state) state = { posted: 0, netted: 0, failed: 0, results: [], attention: [], done: [], runs: 0 };
  state.runs++;

  const rows = jiPendingRows_();
  if (!rows.length) { props.deleteProperty('ji_retry_state'); console.log('Nothing pending.'); return; }

  // one slice per job number (stock / no-number lines together); jobs already handled earlier in this cycle are skipped
  const chunks = {};
  rows.forEach(r => { const k = r.line.ref || '(stock / no job #)'; (chunks[k] = chunks[k] || []).push(r); });
  const keys = Object.keys(chunks).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).filter(k => state.done.indexOf(k) === -1);

  // look every job number up in ONE scan of HCP (remembered for the rest of this run)
  try { const refs = keys.filter(k => k.charAt(0) !== '('); if (refs.length) jiResolveRefs_(refs); } catch (e) { console.log('retry: job lookup failed: ' + e.message); }

  const gone = {}, reasonByKey = {};
  let i = 0, outOfTime = false;
  for (; i < keys.length; i++) {
    if (Date.now() - started > JI_RETRY.BUDGET_MS) { outOfTime = true; break; }
    const chunk = chunks[keys[i]];
    try {
      const plan = jiPlan_(jiCleanLines_(chunk.map(r => r.line)), { fromPending: true });
      const groups = plan.groups.filter(g => g.state === 'ready' && g.job)
        .map(g => ({ job_id: g.job.id, ref: g.job.number, customer: g.job.customer, items: g.items.filter(it => it.use && it.payload) })).filter(g => g.items.length);
      const okRefs = {};
      if (groups.length) {
        const res = withLock_(() => jiApplyLocked_({ groups: groups, no_total: true }, 'morning retry'));
        state.posted += res.posted; state.netted += res.netted; state.failed += res.failed;
        res.results.forEach(r => { state.results.push(r); if (r.ok) okRefs[r.ref] = true; });
      }
      plan.groups.forEach(g => g.items.forEach(it => (it.keys || []).forEach(k => {
        const posted = g.job && okRefs[g.job.number] && it.use && it.payload;
        const alreadyThere = it.k === 'skip';                       // already on the job / already posted / nets to zero
        if (posted || alreadyThere) { gone[k] = true; return; }
        reasonByKey[k] = (g.job ? `job ${g.job.number}: ` : '') + (it.k === 'add' || it.k === 'net' ? 'ready' : it.reason || g.reason || it.k);
      })));
    } catch (e) {
      console.log(`retry ${keys[i]} \u274c ${e.message}`);
      chunk.forEach(r => { reasonByKey[r.key || jiKey_(r.line)] = 'retry error: ' + e.message; });
    }
    state.done.push(keys[i]);
  }

  jiRewritePending_(gone, reasonByKey);
  Object.keys(reasonByKey).forEach(k => {
    const reason = reasonByKey[k];
    if (/held|flag|canceled|which segment|type the job|retry error/.test(reason)) {
      const r = rows.filter(x => (x.key || jiKey_(x.line)) === k)[0];
      if (r) state.attention.push(`job ${r.line.ref || '?'} \u00b7 order ${r.line.order} \u00b7 ${r.line.part} \u00d7 ${r.line.qty}: ${reason}`);
    }
  });
  console.log(`retry slice ${state.runs}: checked ${i} job(s) in ${Math.round((Date.now() - started) / 1000)} s; ${keys.length - i} left; posted so far ${state.posted}`);

  if (outOfTime && state.runs < JI_RETRY.MAX_RUNS) {
    state.results = state.results.slice(-150); state.attention = state.attention.slice(-150);
    props.setProperty('ji_retry_state', JSON.stringify(state));
    ScriptApp.newTrigger('retryPendingContinue').timeBased().after(60 * 1000).create();
    console.log('\u23f3 Out of time for this run - continuing in about a minute.');
    return;
  }
  props.deleteProperty('ji_retry_state');

  const waiting = jiPendingRows_().length;
  const summary = `Job Inputs retry: posted ${state.posted} line(s), netted ${state.netted}, ${waiting} still waiting, ${state.attention.length} need attention` + (state.runs > 1 ? ` (${state.runs} runs)` : '') + (outOfTime ? ' - stopped after the run limit, the rest is checked tomorrow' : '') + '.';
  console.log(summary);
  const to = props.getProperty('REPORT_TO');
  if (to && (state.posted || state.netted || state.failed)) {
    const lines = [summary, ''];
    state.results.forEach(r => lines.push(r.ok ? `\u2705 Job ${r.ref}: ${r.count} line(s) posted` : `\u274c Job ${r.ref}: ${r.error}`));
    if (state.attention.length) { lines.push('', 'Needs attention (open the Job Inputs page or the sheet):'); state.attention.forEach(a => lines.push('  \u2022 ' + a)); }
    lines.push('', 'Sheet: https://docs.google.com/spreadsheets/d/' + props.getProperty('JI_SHEET_ID'));
    GmailApp.sendEmail(to, `Job Inputs \u2014 ${state.posted + state.netted} line(s) posted this morning`, lines.join('\n'), { cc: props.getProperty('REPORT_CC') || '', name: 'Golden Rule Job Inputs' });
  }
}

/** One write to the Pending tab: drop the finished lines, refresh the reasons. Matched by line key, under the lock,
 *  so lines a page upload saved in the meantime are kept. */
function jiRewritePending_(gone, reasonByKey) {
  if (!Object.keys(gone).length && !Object.keys(reasonByKey).length) return;
  withLock_(() => {
    const sh = jiSheet_('Pending');
    if (!sh || sh.getLastRow() < 2) return;
    const n = sh.getLastRow() - 1, w = JI.PENDING_HEADERS.length;
    const v = sh.getRange(2, 1, n, w).getValues();
    const keyOf = r => String(r[14] || '') || jiKey_({ order: String(r[3] || ''), part: String(r[6] || ''), qty: Number(r[8]) || 0, ext: Number(r[9]) || 0 });
    const keep = v.filter(r => !gone[keyOf(r)]).map(r => { const k = keyOf(r); if (reasonByKey[k] !== undefined) r[13] = reasonByKey[k]; return r; });
    sh.getRange(2, 1, n, w).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, w).setValues(keep);
    if (n > keep.length) sh.deleteRows(2 + keep.length, n - keep.length);
  });
  CacheService.getScriptCache().remove('ji_pending_keys');
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'retryPending' || t.getHandlerFunction() === 'retryPendingContinue').forEach(t => ScriptApp.deleteTrigger(t));
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
  return null;
}
function jiRemember_(rid, result) {
  // replay guard for a double-submitted "Apply" - 6 h in the cache is plenty; never stored in script properties
  try { CacheService.getScriptCache().put('ji_req_' + rid, JSON.stringify(Object.assign({}, result, { replay: true })), 21600); } catch (_) {}
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

/** Removes the job_… and ji_req_… cache entries that older versions kept in Script Properties (the settings page goes
 *  read-only past 50 properties). Safe any time - they are only caches and are rebuilt as needed. */
function cleanupProperties() {
  const props = props_();
  const all = props.getProperties();
  let n = 0;
  Object.keys(all).forEach(k => { if (/^(job_|ji_req_)/.test(k)) { props.deleteProperty(k); n++; } });
  const left = Object.keys(props.getProperties());
  console.log(`✅ Removed ${n} cache propert${n === 1 ? 'y' : 'ies'}; ${left.length} left: ${left.sort().join(', ')}`);
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
  if (jiInvOn_()) {
    const cid = jiInvCustomerId_();
    console.log(cid ? `✅ Inventory customer "${jiInvOn_()}" → ${cid}` : `❌ Inventory customer "${jiInvOn_()}" not found in HCP (or several match) — create it or set INVENTORY_CUSTOMER_ID`);
    if (cid) { const by = jiInvJobsByMonth_() || {}; const months = Object.keys(by).sort(); console.log(months.length ? 'Inventory jobs by month: ' + months.map(m => m + ' → #' + by[m].map(j => j.invoice_number).join('/#')).join(', ') : '⚠️ No jobs on the inventory customer yet.'); }
    console.log(`Stock shipped before ${jiInvStart_()} is only logged.`);
  } else console.log('Inventory routing: off');
  console.log(props_().getProperty('ANTHROPIC_API_KEY') ? '✅ ANTHROPIC_API_KEY set — vendor receipts (PDF / photo) can be read.' : '⚠️ ANTHROPIC_API_KEY not set — only Weinstein CSVs will load; set it to read Amazon / other receipts.');
  console.log(`Time zone: ${jiTz_()} (should be America/New_York)`);
  console.log(ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'retryPending') ? '✅ Morning retry installed.' : '⚠️ Run installDailyTrigger() so pending lines post themselves.');
}
