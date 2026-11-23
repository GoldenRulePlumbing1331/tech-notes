/**
 * hcp_po_check.gs — Golden Rule Plumbing & Contracting
 *
 * Does the Housecall Pro public API expose PURCHASE ORDERS yet?
 *
 * HCP added Purchase Orders inside the app in 2026 (vendors, a "+ Purchase Order" button on jobs), but the published
 * API spec has no purchase-order or vendor endpoints. This tries the addresses HCP would most likely use and reports
 * what comes back, next to a made-up address as a control so "doesn't exist" is easy to recognise.
 *
 * SAFE: every call is a GET (read-only). Nothing in HCP changes. It is a separate file with its own helpers (all named
 * po*_), so it doesn't touch or depend on the other code in whichever project it sits in, and the deployed web app
 * is unaffected (a web app runs the version that was deployed, not the editor copy).
 *
 * USE
 *   1. In the "HCP Job Inputs" Apps Script project (any project with Script Property HCP_API_KEY works):
 *      Files "+" → Script → name it hcp_po_check → paste this file → Save.
 *   2. Optional: set PO_TEST_JOB below to a job that has a purchase order on it in HCP (e.g. '49652-1').
 *      Otherwise the newest completed job is used.
 *   3. Pick verifyPurchaseOrders in the function menu → Run → read the Execution log.
 *
 * READING THE RESULT
 *   200            → the endpoint exists and our key can read it (keys of the reply are printed).
 *   401 / 403      → probably exists, but our company key isn't allowed (Application-key-only).
 *   same as control→ the address doesn't exist.
 *   Also prints the field names on a job and on its Job Inputs, in case PO / vendor details show up there instead.
 */

const PO_TEST_JOB = '';   // optional job number with a PO on it, e.g. '49652' or '49652-1'

function verifyPurchaseOrders() {
  const out = ['', '=== HCP purchase-order API check (' + new Date().toISOString().slice(0, 10) + ') ===', ''];

  // Control 1: a call that must work.
  const ok = poGet_('/jobs?page=1&page_size=1');
  if (ok.code !== 200) {
    out.push('❌ GET /jobs → ' + ok.code + ' ' + ok.snippet);
    out.push('Stopping: the API key itself is not working here (check Script Property HCP_API_KEY).');
    console.log(out.join('\n'));
    return;
  }
  out.push('✅ Key works: GET /jobs → 200');

  // Control 2: an address that certainly doesn't exist — what "no such endpoint" looks like.
  const bogus = poGet_('/zz_not_a_real_endpoint_' + Date.now());
  out.push('Control (made-up address) → ' + bogus.code + ' ' + bogus.snippet);
  out.push('');

  const job = poPickJob_();
  out.push(job ? 'Test job: #' + job.invoice_number + ' (' + job.work_status + ')' : '⚠️ No test job found — job-level checks skipped.');
  out.push('');

  const paths = [
    '/purchase_orders?page=1&page_size=1',
    '/api/purchase_orders?page=1&page_size=1',
    '/api/purchasing/purchase_orders?page=1&page_size=1',
    '/api/procurement/purchase_orders?page=1&page_size=1',
    '/vendors?page=1&page_size=1',
    '/api/vendors?page=1&page_size=1',
    '/api/purchasing/vendors?page=1&page_size=1',
  ];
  if (job) {
    paths.push('/jobs/' + job.id + '/purchase_orders');
    paths.push('/api/jobs/' + job.id + '/purchase_orders');
  }

  let found = 0;
  out.push('--- Purchase-order / vendor addresses ---');
  paths.forEach(p => {
    const r = poGet_(p);
    let verdict, show = false;
    if (r.code >= 200 && r.code < 300) { verdict = '✅ EXISTS — readable. Keys: ' + r.keys; found++; }
    else if (r.code === bogus.code && r.html === bogus.html) verdict = '— not there (same as control)';
    else if (r.code === 404) { verdict = '❓ 404 but a different kind of reply than the control — the route may exist'; found++; show = true; }
    else if (r.code === 401 || r.code === 403) { verdict = '🔒 probably exists, key not allowed'; found++; show = true; }
    else { verdict = '❓ unusual answer — look at it'; found++; show = true; }
    const label = job ? p.split('?')[0].split(job.id).join('{job_id}') : p.split('?')[0];
    out.push('[' + r.code + '] GET ' + label + '  ' + verdict + (show ? '  ' + r.snippet : ''));
  });
  out.push('');

  // Maybe the PO details ride along on the job or its Job Inputs instead of their own endpoint.
  if (job) {
    out.push('--- Fields HCP returns on the job and its Job Inputs ---');
    const full = poGet_('/jobs/' + job.id + '?expand[]=purchase_orders&expand[]=attachments');
    if (full.json) {
      const keys = Object.keys(full.json);
      out.push('Job fields: ' + keys.join(', '));
      const hits = keys.filter(k => /purchase|vendor|supplier|\bpo\b|order/i.test(k));
      out.push(hits.length ? '✅ PO-looking job fields: ' + hits.join(', ') : '— no PO / vendor fields on the job');
    } else out.push('GET job → ' + full.code + ' ' + full.snippet);
    const withInputs = poJobWithInputs_(job);
    const inp = withInputs ? withInputs.inp : poGet_('/jobs/' + job.id + '/job_input_materials');
    const first = inp.json && (inp.json.job_input_materials || [])[0];
    if (first) {
      const keys = Object.keys(first);
      out.push('Job Input fields (job #' + withInputs.job.invoice_number + '): ' + keys.join(', '));
      const hits = keys.filter(k => /purchase|vendor|supplier|source|status|order/i.test(k));
      out.push(hits.length ? '✅ PO-looking Job Input fields: ' + hits.join(', ') : '— no vendor / purchase-status fields on Job Inputs');
    } else out.push('Job Inputs: ' + (inp.json ? 'none on this job' : inp.code + ' ' + inp.snippet));
    out.push('');
  }

  out.push(found ? '➡️ Something answered — paste this log to Claude so it can map the endpoint.'
                 : '➡️ No purchase-order access through the public API yet.');
  console.log(out.join('\n'));
}

/* ── helpers (separate names so nothing clashes with the project's own code) ── */

function poGet_(path) {
  const key = PropertiesService.getScriptProperties().getProperty('HCP_API_KEY');
  if (!key) throw new Error('Script Property HCP_API_KEY is not set in this project.');
  const opts = { method: 'get', muteHttpExceptions: true, followRedirects: false,
                 headers: { Authorization: 'Token ' + key, Accept: 'application/json' } };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = UrlFetchApp.fetch('https://api.housecallpro.com' + path, opts);
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep((attempt + 1) * 2000); continue; }
    const text = res.getContentText() || '';
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    const isObj = json && typeof json === 'object' && !Array.isArray(json);
    return {
      code: code,
      json: code >= 200 && code < 300 ? json : null,
      keys: isObj ? Object.keys(json).join(', ') : (Array.isArray(json) ? 'array of ' + json.length : '(not JSON)'),
      snippet: text.replace(/\s+/g, ' ').slice(0, 140),
      html: /^\s*</.test(text),   // Rails answers unknown routes with an HTML page; real endpoints answer JSON
    };
  }
  return { code: 429, json: null, keys: '', snippet: 'HCP kept answering busy' };
}

/** The test job if it has Job Inputs, else the first of the newest completed jobs that does (checks up to 10). */
function poJobWithInputs_(job) {
  const tried = {};
  const check = j => { tried[j.id] = 1; const inp = poGet_('/jobs/' + j.id + '/job_input_materials'); return inp.json && (inp.json.job_input_materials || []).length ? { job: j, inp: inp } : null; };
  const own = check(job); if (own) return own;
  const r = poGet_('/jobs?page=1&page_size=100&sort_by=created_at&sort_direction=desc&work_status[]=completed');
  const jobs = ((r.json && r.json.jobs) || []).filter(j => !tried[j.id]).slice(0, 10);
  for (let i = 0; i < jobs.length; i++) { const hit = check(jobs[i]); if (hit) return hit; }
  return null;
}

function poPickJob_() {
  const want = String(PO_TEST_JOB || '').trim();
  for (let page = 1; page <= 5; page++) {
    const r = poGet_('/jobs?page=' + page + '&page_size=100&sort_by=created_at&sort_direction=desc');
    const jobs = (r.json && r.json.jobs) || [];
    const hit = want
      ? jobs.find(j => String(j.invoice_number) === want) || jobs.find(j => String(j.invoice_number).indexOf(want + '-') === 0)
      : jobs.find(j => /complete/i.test(j.work_status || ''));
    if (hit) return hit;
    if (!jobs.length || page >= ((r.json && r.json.total_pages) || 1)) break;
  }
  return null;
}
