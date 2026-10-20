function probe() {
  const L = s => console.log(s);
  const kyle = dpEmployees_().filter(e => e.name === 'Kyle Hunt')[0];
  L('KYLE ' + (kyle ? kyle.id : 'NOT FOUND'));
  const j2 = dpJobsByNumber_('49802')[0], j4 = dpJobsByNumber_('49804')[0];
  L('JOBS ' + j2.id + ' ' + j4.id);
  const un = dpUnassigned_(true);
  L('UNASSIGNED list has 49802: ' + JSON.stringify(un.items.filter(i => i.number === '49802').map(i => [i.group, i.when])) + ' 49804: ' + JSON.stringify(un.items.filter(i => i.number === '49804').map(i => [i.group, i.when])) + ' counts ' + JSON.stringify(un.counts));
  let d = dpDay_('2026-10-21', true);
  L('BOARD Oct21 49802: ' + JSON.stringify(d.items.filter(i => i.number === '49802').map(i => [i.time, i.employee_ids, i.amount, i.customer, i.title])));
  let r = dpApply_({ req_id: 'ct-a-' + Date.now(), job_id: j2.id, change: { date: '2026-10-22', time: '09:00', duration_min: 120, arrival_min: 120, employee_ids: [], notify_customer: false, notify_pro: false, note: 'Claude test — time change' } }, 'Claude test for Kyle');
  L('TIME CHANGE ' + JSON.stringify(r.message));
  r = dpApply_({ req_id: 'ct-b-' + Date.now(), job_id: j2.id, change: { employee_ids: [kyle.id], note: 'Claude test — crew' } }, 'Claude test for Kyle');
  L('CREW CHANGE ' + JSON.stringify(r.message));
  const back = dpJobOut_(hcp_('get', '/jobs/' + j2.id + '?expand[]=appointments'));
  L('READBACK 49802 ' + JSON.stringify([back.when, back.employees, back.arrival_min, back.duration_min]));
  d = dpDay_('2026-10-22', true);
  L('BOARD Oct22 49802: ' + JSON.stringify(d.items.filter(i => i.number === '49802').map(i => [i.time, i.employee_ids.map(id => id === kyle.id ? 'Kyle' : id)])));
  const un2 = dpUnassigned_(true);
  L('UNASSIGNED after: 49802 present? ' + un2.items.some(i => i.number === '49802'));
  r = dpApply_({ req_id: 'ct-c-' + Date.now(), job_id: j4.id, change: { date: '2026-10-23', time: '13:00', duration_min: 60, arrival_min: 0, employee_ids: [], notify_customer: false, notify_pro: false } }, 'Claude test for Kyle');
  L('SCHEDULE 49804 ' + JSON.stringify(r.message));
  r = dpUnschedule_({ job_id: j4.id }, 'Claude test for Kyle');
  L('UNSCHEDULE 49804 ' + JSON.stringify(r.message));
  const b4 = dpJobOut_(hcp_('get', '/jobs/' + j4.id));
  L('READBACK 49804 ' + JSON.stringify([b4.scheduled, b4.status, b4.when]));
  const notes = hcp_('get', '/jobs/' + j2.id).notes;
  L('NOTES 49802 ' + JSON.stringify((notes || []).map(n => n.content).filter(c => /Dispatch/.test(c))));
}
