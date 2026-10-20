function probe() {
  const L = s => console.log(s);
  let msg = withLock_(() => handle_('49802', 'um so I rebuilt the toilet, replaced the flapper and the fill valve, uh, and snaked the kitchen sink and it drains good now. testing testing', 'replace', { clean: true, who: 'Claude test for Kyle' }));
  L('REPLACE ' + JSON.stringify(msg));
  msg = withLock_(() => handle_('49802', 'also told the customer the shutoff under the sink is seized', 'append', { clean: true, who: 'Claude test for Kyle' }));
  L('APPEND ' + JSON.stringify(msg));
  const job = findJob_('49802');
  const li = hcp_('get', '/jobs/' + job.id + '/line_items');
  L('LINE ITEMS ' + JSON.stringify((li.data || li.line_items || []).map(x => [x.name, x.unit_price, x.description])));
  const notes = hcp_('get', '/jobs/' + job.id).notes;
  L('NOTES ' + JSON.stringify((notes || []).map(n => n.content)));
}
