function probe() {
  const L = s => console.log(s);
  const text = 'Estimate for Test Customer at 1319 Pottstown Pike in West Chester. Option one, replace the 50 gallon gas water heater. Option two, install a tankless water heater. Schedule the visit Friday at 11.';
  const r = esParse_(text, '');
  L('PARSE matches ' + JSON.stringify(r.matches.slice(0, 3).map(c => [c.id, c.display_name])));
  L('PARSE options ' + JSON.stringify(r.estimate.options.map(o => [o.name, o.line_items.map(li => [li.name, li.unit_price, (li.candidates[0] || {}).name])])));
  L('PARSE visit ' + r.estimate.visit_date + ' ' + r.estimate.visit_time + ' type ' + r.estimate.job_type_id);
  const c = r.matches.filter(m => /CustomerTest|Test Customer/i.test(m.display_name + ' ' + m.first_name + ' ' + m.last_name))[0];
  if (!c) { L('NO TEST CUSTOMER'); return; }
  const a = c.addresses.filter(x => /1319/.test(x.text))[0] || c.addresses[0];
  const est = Object.assign({}, r.estimate, { employee_id: '', arrival: 0 });
  const res = esCreate_({ req_id: 'ct-es-' + Date.now(), customer_id: c.id, address_id: a.id, estimate: est }, 'Claude test for Kyle');
  L('CREATE ' + JSON.stringify({ ok: res.ok, error: res.error, number: res.estimate_number, dropped: res.dropped }));
  L('MESSAGE ' + JSON.stringify(res.message));
  if (res.ok) {
    const e = hcp_('get', '/estimates/' + res.estimate_id);
    L('READBACK ' + JSON.stringify({ number: e.estimate_number, status: e.work_status, assigned: (e.assigned_employees || []).map(x => x.first_name + ' ' + x.last_name), sched: e.schedule && [e.schedule.scheduled_start, e.schedule.scheduled_end], options: (e.options || []).map(o => [o.name, o.total_amount, o.approval_status]) }));
  }
}
