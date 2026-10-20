function probe() {
  const L = s => console.log(s);
  const who = 'Claude test for Kyle';
  const A = [
    { order: 'TEST-1001', date: '10/20/2026', po: 'PO # 49802', ref: '49802', part: '1492540', desc: '3/4 90 ELBOW', qty: 2, ext: 3.10, uom: 'EA', kind: 'purchase', row: 2 },
    { order: 'TEST-1001', date: '10/20/2026', po: 'PO # 49802', ref: '49802', part: 'TESTFLAP', desc: 'UNIVERSAL TOILET FLAPPER (TEST)', qty: 1, ext: 8.50, uom: 'EA', kind: 'purchase', row: 3 },
    { order: 'TEST-1002', date: '10/20/2026', po: 'PO # 49802', ref: '49802', part: '1492540', desc: '3/4 90 ELBOW (BOX)', qty: 1, ext: 150.00, uom: 'BX', kind: 'purchase', row: 4 },
  ];
  const show = (tag, plan) => plan.groups.forEach(g => L(tag + ' group ' + (g.ref || '-') + ' state ' + g.state + ' ' + (g.reason || '') + ' :: ' + JSON.stringify(g.items.map(it => [it.k, it.order, it.part, it.qty, it.cents, it.reason]))));
  const sh = jiSheet_('Posted'); const before = sh.getLastRow();
  const planA = jiPlan_(jiCleanLines_(A), {});
  show('PLAN A', planA);
  const g = planA.groups.filter(x => x.job && x.state === 'ready')[0];
  if (!g) { L('Job not ready (not complete yet?) — stopping before posting anything.'); return; }
  const pick = it => it.use && it.payload && (it.k === 'add' || it.k === 'net' || it.k === 'held');
  const resA = jiApply_({ req_id: 'ct-ji-a-' + Date.now(), groups: [{ job_id: g.job.id, ref: g.job.number, customer: g.job.customer, items: g.items.filter(pick) }], pending: [] }, who);
  L('APPLY A ' + JSON.stringify({ ok: resA.ok, msg: resA.message, results: resA.results }));
  const inputs = () => ((hcp_('get', '/jobs/' + g.job.id + '/job_input_materials') || {}).job_input_materials || []).map(m => [m.name, m.part_number, m.quantity, m.unit_cost, m.description]);
  L('HCP INPUTS after A ' + JSON.stringify(inputs()));
  // B: the next week's export overlaps (same lines again) and has a return of one elbow from order TEST-1001
  const B = A.slice(0, 2).concat([{ order: 'TEST-1003', date: '10/21/2026', po: 'PO # return', ref: '49802', part: '1492540', desc: '3/4 90 ELBOW', qty: -1, ext: -1.55, uom: 'EA', kind: 'return', orig: 'TEST-1001', row: 5 }]);
  const planB = jiPlan_(jiCleanLines_(B), {});
  show('PLAN B', planB);
  const gb = planB.groups.filter(x => x.job && x.state === 'ready')[0];
  if (gb) {
    const resB = jiApply_({ req_id: 'ct-ji-b-' + Date.now(), groups: [{ job_id: gb.job.id, ref: gb.job.number, customer: gb.job.customer, items: gb.items.filter(pick) }], pending: [] }, who);
    L('APPLY B ' + JSON.stringify({ ok: resB.ok, msg: resB.message }));
  }
  L('HCP INPUTS after B ' + JSON.stringify(inputs()));
  const added = sh.getLastRow() - before;
  if (added > 0) { sh.deleteRows(before + 1, added); CacheService.getScriptCache().remove('ji_posted_keys'); }
  L('POSTED-TAB test rows removed: ' + added);
}
