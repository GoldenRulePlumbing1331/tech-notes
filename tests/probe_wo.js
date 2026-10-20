function probe() {
  const L = s => console.log(s);
  L('MODE ' + weinMode_() + ' email ' + woEmailOn_());
  const r = woParse_('For job 49802 I need two three quarter copper ninety elbows, one universal toilet flapper, and a wax ring. Pickup at West Chester tomorrow morning.');
  L('REQUEST ' + JSON.stringify(r.request) + ' catalog ' + r.catalog + ' job ' + JSON.stringify(r.job) + ' err ' + r.job_error);
  r.items.forEach(it => L('ITEM ' + JSON.stringify([it.qty, it.spoken, it.part, (it.candidates || []).slice(0, 3).map(c => [c.part, c.desc, Math.round((c.score || 0) * 100) / 100])])));
  L('NOT PLACED — preview only (no email, no Weinstein cart/order).');
}
