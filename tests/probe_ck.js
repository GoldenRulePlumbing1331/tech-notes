function probe() {
  const L = s => console.log(s);
  const who = 'Kyle Hunt';
  const init = ckInit_(who);
  L('INIT employee_known ' + init.employee_known + ' today ' + init.today + ' jobs ' + JSON.stringify(init.jobs.map(j => j.number + ' ' + j.start_text)));
  const base = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const evs = [['omw', base - 12 * 60000], ['start', base - 2 * 60000], ['finish', base]];
  const sh = ckSheet_('Log'); const before = sh.getLastRow();
  evs.forEach((e, i) => {
    const r = ckStamp_({ req_id: 'ct-ck-' + i + '-' + base, event: e[0], at: iso(e[1]), number: '49802', note: i === 0 ? 'Claude test' : '' }, who);
    L('STAMP ' + e[0] + ' ' + JSON.stringify({ ok: r.ok, msg: r.message, logged: r.logged, noted: r.noted }));
  });
  const again = ckStamp_({ req_id: 'ct-ck-0-' + base, event: 'omw', at: iso(base - 12 * 60000), number: '49802' }, who);
  L('REPLAY same req_id → same answer, no new row: ' + (sh.getLastRow() === before + 3) + ' ' + again.message);
  const rows = sh.getRange(before + 1, 1, 3, 10).getValues();
  L('SHEET ROWS ' + JSON.stringify(rows.map(r => [r[2], r[3], r[4], r[5], r[6]])));
  const job = ckJobByNumber_('49802');
  L('NOTES ' + JSON.stringify((hcp_('get', '/jobs/' + job.id).notes || []).map(n => n.content).filter(c => /⏱/.test(c))));
  sh.deleteRows(before + 1, 3);   // test rows out, so Monday's report doesn't list them
  L('TEST ROWS REMOVED, last row back to ' + sh.getLastRow() + ' (was ' + before + ')');
}
