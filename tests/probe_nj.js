function probe() {
  const L = s => console.log(s);
  const text = 'Test Customer at 1319 Pottstown Pike West Chester. The toilet runs constantly, needs a toilet rebuild, and the kitchen sink is clogged. Schedule it tomorrow at 10.';
  const r = njParse_(text, '');
  L('PARSE fields ' + JSON.stringify(r.fields));
  L('PARSE matches ' + JSON.stringify(r.matches.slice(0, 4).map(c => [c.id, c.display_name, c.addresses.map(a => a.id + ' ' + a.text)])));
  L('PARSE suggestions ' + JSON.stringify(r.suggestions.map(s => [s.name, s.custom ? 'CUSTOM' : (s.candidates[0] || {}).name, s.candidates[0] && s.candidates[0].strong])));
  L('PARSE tags ' + JSON.stringify(r.tags.map(t => t.name)));
  const c = r.matches.filter(m => /test/i.test(m.first_name + m.last_name) && /customer/i.test(m.first_name + m.last_name))[0];
  if (!c) { L('NO TEST CUSTOMER MATCH — stopping'); return; }
  const a = c.addresses.filter(x => /1319/.test(x.street))[0] || c.addresses[0];
  const items = r.suggestions.filter(s => !s.custom && s.candidates.length).map(s => { const k = s.candidates[0];
    return { uuid: k.uuid, name: k.name, description: k.description, quantity: s.quantity || 1, unit_price: k.price, unit_cost: k.cost, kind: 'labor', taxable: k.taxable }; });
  const payload = { req_id: 'claudetest-' + Date.now(), customer_id: c.id, address_id: a.id,
    job: { description: r.fields.job_description, date: r.fields.date, time: r.fields.time, arrival: '120', employee_id: '', job_type_id: '', business_unit_id: '',
           tag_ids: r.tags.map(t => t.id), line_items: items } };
  L('CREATE payload job ' + JSON.stringify({ date: payload.job.date, time: payload.job.time, items: items.map(i => i.name), tags: payload.job.tag_ids.length, addr: a.text }));
  const res = njCreate_(payload, 'Claude test for Kyle');
  L('CREATE result ' + JSON.stringify({ ok: res.ok, error: res.error, number: res.invoice_number, unassign: res.unassign, dn: res.display_name_todo }));
  L('CREATE message ' + JSON.stringify(res.message));
  if (res.ok) {
    const j = hcp_('get', '/jobs/' + res.job_id);
    L('READBACK ' + JSON.stringify({ num: j.invoice_number, status: j.work_status, assigned: (j.assigned_employees || []).map(e => e.first_name + ' ' + e.last_name), sched: j.schedule && [j.schedule.scheduled_start, j.schedule.scheduled_end, j.schedule.arrival_window], tags: j.tags, desc: j.description }));
    const li = hcp_('get', '/jobs/' + res.job_id + '/line_items');
    L('LINE ITEMS ' + JSON.stringify((li.data || li.line_items || []).map(x => [x.name, x.quantity, x.unit_price, (x.description || '').split('\n').length + ' lines'])));
    PropertiesService.getScriptProperties().setProperty('CLAUDE_TEST_JOB', JSON.stringify({ id: res.job_id, number: res.invoice_number, customer_id: c.id, address_id: a.id }));
  }
  L('UNASSIGN_LOG ' + PropertiesService.getScriptProperties().getProperty('NJ_UNASSIGN_LOG'));
  // B. brand-new customer (display-name message), same address with no ZIP so the lookup runs
  const res2 = njCreate_({ req_id: 'claudetest2-' + Date.now(), customer: { first_name: 'NewCust', last_name: 'ZZTest', company: '', phone: '', email: '' },
    address: { street: '1319 Pottstown Pike', city: 'West Chester', state: 'PA', zip: '' }, job: { description: 'Test job — new customer check. Safe to delete.', employee_id: '' } }, 'Claude test for Kyle');
  L('NEWCUST result ' + JSON.stringify({ ok: res2.ok, error: res2.error, number: res2.invoice_number, dn: res2.display_name_todo, url: res2.customer_url, unassign: res2.unassign }));
  L('NEWCUST message ' + JSON.stringify(res2.message));
  if (res2.ok) { const j2 = hcp_('get', '/jobs/' + res2.job_id); L('NEWCUST readback ' + JSON.stringify({ assigned: (j2.assigned_employees || []).length, zip: (j2.address || {}).zip, cust: j2.customer && j2.customer.id }));
    PropertiesService.getScriptProperties().setProperty('CLAUDE_TEST_JOB2', JSON.stringify({ id: res2.job_id, number: res2.invoice_number, customer_id: j2.customer && j2.customer.id })); }
}
