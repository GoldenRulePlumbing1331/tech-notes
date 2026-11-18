/* Mock of the Golden Rule Apps Script web apps, used by the Playwright checks.
 * Routes every https://script.google.com/... request by the endpoint id in config.js and answers like the real script. */
const fs = require("fs");
const path = require("path");

function endpointKeys(configJsPath) {
  const src = fs.readFileSync(configJsPath, "utf8");
  const m = /GR_ENDPOINTS\s*=\s*(\{[\s\S]*?\});/.exec(src);
  const obj = Function("return " + m[1])();
  const byUrl = {};
  Object.keys(obj).forEach(k => { byUrl[obj[k]] = k; });
  return byUrl;
}

const EMPS = [{ id: "e1", name: "Kyle Hunt" }, { id: "e2", name: "Mike Smith" }, { id: "e3", name: "Dave Jones" }];
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());   // the pages compare this with the phone's own date
const GOOD = "12345678";

function job(n) {
  return { id: "job_" + n, number: String(n), customer: "Test Customer", company: "", phone: "6105551212", address: "1319 Pottstown Pike, West Chester",
    description: "Replace hose bib", status: "scheduled", scheduled: true, date: TODAY, time: "09:00", end_time: "11:00", duration_min: 120, arrival_min: 120,
    when: "Fri Oct 30, 9:00 AM–11:00 AM", employee_ids: ["e1"], employees: ["Kyle Hunt"], appointments: [], multi_day: false, tz: "America/New_York" };
}

/* Customer History (history.html): tool "history" on the Estimate endpoint. Money is cents, like the real script. */
const H_CUST = { id: "c1", display_name: "DoeJohn", first_name: "John", last_name: "Doe", company: "", email: "john@example.com",
  phones: [{ label: "Mobile", number: "6105551212", text: "(610) 555-1212" }],
  addresses: [{ id: "a1", type: "service", street: "12 Main St", city: "West Chester", state: "PA", zip: "19380", text: "12 Main St, West Chester, PA 19380" },
              { id: "a2", type: "service", street: "40 Lake Rd", city: "Exton", state: "PA", zip: "19341", text: "40 Lake Rd, Exton, PA 19341" }] };
function hJob(n, daysAgo, state, title, extra) {
  const ms = Date.now() - daysAgo * 86400000;
  return Object.assign({ id: "job_" + n, number: String(n), title, ms, dated: true, when: new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }),
    state, address_id: "a1", address: "12 Main St, West Chester", techs: ["Kyle Hunt"], total: 35000, due: 0, tags: [], notes: [], url: "https://pro.housecallpro.com/app/jobs/job_" + n }, extra || {});
}
function history(p) {
  switch (p.action) {
    case "init": return { ok: true, who: "Kyle Hunt", today: TODAY };
    case "search": {
      const q = String(p.q || "").toLowerCase();
      if (/nobody/.test(q)) return { ok: true, matches: [] };
      const two = Object.assign({}, H_CUST, { id: "c2", display_name: "DoeJane", first_name: "Jane", addresses: [H_CUST.addresses[1]], score: 3 });
      return { ok: true, matches: /doe$/.test(q) ? [Object.assign({ score: 4 }, H_CUST), two] : [Object.assign({ score: 5 }, H_CUST)] };
    }
    case "customer": {
      if (p.customer_id !== "c1") return { ok: false, error: "HCP couldn’t find that customer. Search again." };
      const jobs = [
        hJob(49900, -3, "scheduled", "Annual water heater flush", { total: 18500, due: 18500 }),
        hJob(49370, 20, "done", "Replace hose bib", { total: 35000, due: 35000, tags: ["Outdoor"], work: "Replaced the frost-free hose bib on the back wall. Tested, no leaks.", lines: [{ name: "Hose Bib Replacement", description: "12in frost-free", qty: 1, price: 32500, amount: 32500, discount: false }, { name: "Shutoff Valve - 1/2in", description: "", qty: 1, price: 2500, amount: 2500, discount: false }] }),
        hJob(48110, 200, "done", "50 Gallon, Natural, Atmospheric (BW)", { total: 210000, tags: ["Water Heater"], techs: ["Mike Smith", "Dave Jones"], work: "Swapped the leaking 50 gal gas water heater. New expansion tank." }),
        hJob(47002, 420, "canceled", "Kitchen Sink Clog", { total: 0 }),
        hJob(46500, 800, "done", "Sump pump install", { total: 95000, address_id: "a2", address: "40 Lake Rd, Exton", tags: ["Sump"], notes: ["Gate code 4411"] }),
      ];
      for (let i = 0; i < 30; i++) jobs.push(hJob(40000 - i, 900 + i * 30, "done", "Service call " + (i + 1), { total: 15000 }));
      return { ok: true, customer: Object.assign({ tags: ["Repeat"], notes: "Dog in the yard. Use the side door.", lead_source: "Google", since: "Mar 2019", url: "https://pro.housecallpro.com/app/customers/c1" }, H_CUST),
        summary: { jobs: 34, done: 33, canceled: 1, billed: 790000, due: 35000, last: jobs[1].when, last_ms: jobs[1].ms, next: jobs[0].when, first_year: "2019", open_estimates: 1 },
        jobs, estimates: [{ id: "est_1", number: "2224", ms: Date.now() - 30 * 86400000, when: "Tue Oct 20, 2026", state: "open", address_id: "a1", address: "12 Main St, West Chester", techs: ["Kyle Hunt"],
          options: [{ id: "o1", name: "Option 1", number: "2224-1", total: 210000, approval: "awaiting response" }, { id: "o2", name: "Tankless", number: "2224-2", total: 480000, approval: "awaiting response" }], url: "https://pro.housecallpro.com/app/estimates/est_1" }],
        total_jobs: 35, truncated: false, warnings: [], loaded_at: "Nov 18, 11:20 AM" };
    }
    case "job": return { ok: true, job_id: p.job_id, number: p.job_id.replace("job_", ""), lines_ok: true,
      lines: p.job_id === "job_49370" ? [{ name: "Hose Bib Replacement", description: "12in frost-free", qty: 1, price: 32500, amount: 32500, discount: false }, { name: "Shutoff Valve - 1/2in", description: "", qty: 2, price: 1250, amount: 2500, discount: false }]
        : [{ name: "Sump Pump Installation", description: "1/2 HP Zoeller, new check valve", qty: 1, price: 95000, amount: 95000, discount: false }],
      work: p.job_id === "job_46500" ? "Installed a new 1/2 HP sump pump and check valve in the basement pit." : "", notes: ["Gate code 4411"], photos_ok: true,
      photos: [{ id: "p1", name: "before.jpg", url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", image: true }, { id: "p2", name: "permit.pdf", url: "https://example.com/permit.pdf", image: false }] };
    case "option": return { ok: true, option_id: p.option_id, lines: [{ name: "50 gal water heater", description: "Replace the 50 gallon gas water heater.", qty: 1, price: 210000, amount: 210000, discount: false }] };
  }
  return { ok: false, error: "Unknown action." };
}

const handlers = {
  notes(p) { return { text: p.token === GOOD ? "✅ Job " + p.job + " updated: Technician's Notes set." : "❌ That access code isn’t valid." }; },
  dispatch(p) {
    if (p.token !== GOOD) return { ok: false, error: "That access code isn’t valid." };
    switch (p.action) {
      case "init": return { ok: true, who: "Kyle Hunt", me: "e1", employees: EMPS, today: TODAY, can_dispatch: true };
      case "board": return { ok: true, jobs: [job(49370)] };
      case "job": return { ok: true, jobs: [job(p.number)] };
      case "parse": return { ok: true, request: { action: "reschedule", job_number: "49370", date: TODAY, time: "13:00", employee_ids: ["e2"], replace_crew: true }, jobs: [job(49370)] };
      case "apply": return { ok: true, message: "✅ Job 49370 updated.\nTest Customer — 1319 Pottstown Pike\nFri Oct 30, 1:00 PM–3:00 PM · Mike Smith" };
      case "unschedule": return { ok: true, message: "✅ Job 49370 taken off the schedule." };
      case "day": return { ok: true, who: "Kyle Hunt", me: "e1", can_dispatch: true, date: p.date || TODAY, label: "Fri, Oct 30", today: TODAY, now_min: 600,
        techs: EMPS.map((e, i) => ({ id: e.id, name: e.name, short: e.name.split(" ")[0] + " " + e.name.split(" ")[1][0] + ".", initials: e.name.split(" ").map(x => x[0]).join(""), color: ["#1e88e5", "#43a047", "#8e24aa"][i], role: "field tech" })),
        items: [{ id: "job_49370", job_id: "job_49370", kind: "job", number: "49370", title: "Replace hose bib", customer: "CustomerTest", full_name: "Test Customer", company: "", address: "1319 Pottstown Pike, West Chester", zip: "19380", phone: "6105551212", all_day: false, smin: 540, emin: 660, time: "9:00 AM–11:00 AM", day_of: "", employee_ids: ["e1"], amount: 350, estimate_amount: 0, status: "scheduled", omw: "", started: "", done: "", unit: "Plumbing", type: "Service", tags: [], url: "https://pro.housecallpro.com/app/jobs/job_49370" },
                { id: "ev1:" + TODAY, kind: "event", number: "", title: "Emergency Phone", customer: "", note: "", address: "", all_day: true, smin: 0, emin: 1440, time: "All day", employee_ids: ["e2"], amount: 0, status: "event", omw: "", started: "", done: "", unit: "", type: "", url: "" }],
        warnings: [], events_stale: false, loaded_at: "12:30 PM" };
      case "unassigned": return { ok: true, today: TODAY, items: [], warnings: [], counts: { past: 0, upcoming: 0, unscheduled: 0 }, loaded_at: "12:30 PM" };
      case "events_sync": return { ok: true, skipped: true };
      case "capacity": return { ok: true, date: p.date || TODAY, label: "Fri, Oct 30", today: TODAY, is_today: true, past: false, now_min: 600, day_start: 480, day_end: 960, cursor: 600, over: false,
        drive_min: 22, typical_min: 90, typical_range: [60, 150], loaded_at: "12:30 PM", warnings: [], learning: false, stats_stale: false,
        stats_info: { used: 4120, seen: 5210, from: "Nov 6, 2025", at: "Nov 6" },
        common: [{ label: "Service Call", min: 85, p25: 60, p75: 120, n: 2100, crew: 1 }, { label: "Water Heater Replacement", min: 195, p25: 160, p75: 240, n: 310, crew: 2 }, { label: "Drain Cleaning", min: 80, p25: 55, p75: 110, n: 640, crew: 1 }],
        techs: [
          { id: "e1", name: "Dom Russo", short: "Dom R.", initials: "DR", color: "#1e88e5", truck: true, lead: true, booked_min: 112, blocked_min: 0, scheduled: true, off: false, jobs: 2, left: 1, done: 1, rem_min: 112, blocked_min: 0, open_min: 248, finish_min: 712,
            items: [{ number: "49370", kind: "job", customer: "CustomerTest", time: "9:00 AM–11:00 AM", state: "todo", typical: 90, basis: "Service Call (2100 jobs)", rem: 112, note: "" }] },
          { id: "e2", name: "Mark Smith", short: "Mark S.", initials: "MS", color: "#43a047", truck: true, lead: true, booked_min: 420, blocked_min: 0, scheduled: true, off: false, jobs: 3, left: 3, done: 0, rem_min: 420, blocked_min: 0, open_min: -60, finish_min: 1020,
            items: [{ number: "49371", kind: "job", customer: "DoeJohn", time: "10:00 AM–2:00 PM", state: "work", typical: 195, basis: "Water Heater Replacement (310 jobs)", rem: 150, note: "" }] },
          { id: "e3", name: "Kevin Jones", short: "Kevin J.", initials: "KJ", color: "#8e24aa", truck: true, lead: true, booked_min: 0, blocked_min: 0, scheduled: false, off: false, jobs: 0, left: 0, done: 0, rem_min: 0, blocked_min: 0, open_min: 360, finish_min: 600, items: [] },
          { id: "e4", name: "Sam Lee", short: "Sam L.", initials: "SL", color: "#f4511e", truck: true, lead: true, scheduled: true, off: false, jobs: 1, left: 1, done: 0, rem_min: 360, blocked_min: 0, booked_min: 360, open_min: 0, finish_min: 960, full_day: { number: "49380", customer: "BigJob", hours: 7 }, items: [{ number: "49380", kind: "job", customer: "BigJob", time: "8:00 AM–3:00 PM", state: "work", typical: 420, basis: "booked 7 h — full day", rem: 360, note: "" }] },
          { id: "e5", name: "Rudy Perez", short: "Rudy P.", initials: "RP", color: "#6d4c41", truck: false, lead: false, scheduled: true, off: false, jobs: 1, left: 1, done: 0, rem_min: 90, blocked_min: 0, booked_min: 90, open_min: 270, finish_min: 690, items: [] }] };
      case "cap_stats": return { ok: true, skipped: true };
      case "loose_ends": return { ok: true, date: p.date || TODAY, range: p.range || "day", from: TODAY, to: TODAY, today: TODAY, label: "Fri, Oct 30", checked: { finished: 9, running: 2, total: 14 }, loaded_at: "12:30 PM", warnings: [],
        no_price: [{ job_id: "job_49360", number: "49360", why: "no price", detail: "2 line items, all $0", customer: "SmithJane", address: "5 Elm St, Exton", title: "Toilet running", date: TODAY, when: "Fri, Oct 30 · 8:00 AM", sort: 1, status: "complete unrated", amount: 0, techs: ["Mike Smith"], done: "Fri 9:40 AM", started: "", tags: [], url: "https://pro.housecallpro.com/app/jobs/job_49360" }],
        stuck: [{ job_id: "job_49300", number: "49300", why: "in progress, no return visit", detail: "started Tue 10:02 AM · no later appointment and no other open segment", customer: "LeeBob", address: "9 Oak Ln, West Chester", title: "Sewer line camera", date: "2026-10-27", when: "Tue, Oct 27 · 10:00 AM", sort: 0, status: "in progress", amount: 850, techs: ["Kyle Hunt"], done: "", started: "Tue 10:02 AM", tags: [], url: "https://pro.housecallpro.com/app/jobs/job_49300" }],
        no_notes: [] };
    }
    return { ok: false, error: "Unknown action." };
  },
  newJob(p) {
    if (p.token !== GOOD) return { ok: false, error: "That access code isn’t valid." };
    switch (p.action) {
      case "init": return { ok: true, who: "Kyle Hunt", me: "e1", employees: EMPS, today: TODAY, job_types: [{ id: "t1", name: "Service" }], business_units: [{ id: "b1", name: "Plumbing" }], usual_unit: { t1: "b1" }, price_book: true, tags: [{ id: "g1", name: "Water Heater" }, { id: "g2", name: "Drain" }], photos: true };
      case "parse": return { ok: true, fields: { first_name: "John", last_name: "Doe", phone: "6105551212", street: "12 Main St", city: "West Chester", state: "PA", zip: "", job_description: "Leaking hose bib", date: TODAY, time: "13:00", job_type_id: "t1", business_unit_id: "b1" },
        matches: [{ id: "c1", display_name: "DoeJohn", first_name: "John", last_name: "Doe", phones: [{ text: "(610) 555-1212", label: "mobile" }], addresses: [{ id: "a1", text: "12 Main St, West Chester, PA 19380", street: "12 Main St", type: "service" }], email: "", score: 5 }],
        suggestions: [{ name: "hose bib", quantity: 1, candidates: [{ uuid: "s1", name: "Hose Bib Replacement", description: "", price: 32500, cost: 4000, taxable: false, strong: true }] }], tags: [{ id: "g1", name: "Water Heater" }] };
      case "search": return { ok: true, matches: [] };
      case "services": return { ok: true, candidates: [] };
      case "classify": return { ok: true, job_type_id: "t1", business_unit_id: "b1" };
      case "address": return { ok: true, found: true, zip: "19380", source: "census" };
      case "create": return { ok: true, message: "✅ Job 49999 created for DoeJohn.\nFri Oct 30, 1:00 PM · Unassigned", job_id: "job_49999", invoice_number: "49999" };
      case "photo": return p.job_id === "job_49999" && p.data ? { ok: true, name: "job49999_" + p.n + ".jpg" } : { ok: false, error: "bad photo" };
    }
    return { ok: false, error: "Unknown action." };
  },
  estimate(p) {
    if (p.token !== GOOD) return { ok: false, error: "That access code isn’t valid." };
    if (p.tool === "history") return history(p);   // the Customer History page reads through the Estimate script
    switch (p.action) {
      case "init": return { ok: true, who: "Kyle Hunt", me: "e1", employees: EMPS, today: TODAY, job_types: [{ id: "t1", name: "Service" }], business_units: [{ id: "b1", name: "Plumbing" }], usual_unit: { t1: "b1" }, price_book: true };
      case "parse": return { ok: true, fields: { first_name: "John", last_name: "Doe", street: "12 Main St", city: "West Chester", state: "PA" }, estimate: { message: "", options: [{ name: "Option 1", line_items: [{ name: "50 gal water heater", description: "Replace the 50 gallon gas water heater.", quantity: 1, unit_price: 210000, unit_cost: 90000, candidates: [] }] }] }, matches: [] };
      case "estimates": return { ok: true, estimates: [] };
      case "price": return { ok: true, candidates: [] };
      case "rewrite": return { ok: true, option: p.option };
      case "create": return { ok: true, message: "✅ Draft estimate #E100 created." };
    }
    return { ok: false, error: "Unknown action." };
  },
  order(p) {
    if (p.token !== GOOD) return { ok: false, error: "That access code isn’t valid." };
    switch (p.action) {
      case "init": return { ok: true, who: "Kyle Hunt", today: TODAY, shop_address: "1331 Pottstown Pike, West Chester, PA 19380", email_on: true, email_to: "tj@example.com", catalog: 443, weinstein: "off" };
      case "parse": return { ok: true, request: { stock: false, job_number: "49370", fulfillment: "pickup", deliver_to: "job", needed_by: "today by 2", notes: "" }, job: { number: "49370", customer: "Test Customer", address: "1319 Pottstown Pike", description: "Replace hose bib" }, job_error: "", catalog: 443,
        items: [{ qty: 2, spoken: "3/4 PEX elbows", search: "3/4 PEX elbows", candidates: [{ part: "PEX34ELL", desc: "3/4 PEX ELBOW", uom: "EA", score: 0.95 }], part: "PEX34ELL", note: "" }] };
      case "match": return { ok: true, candidates: [] };
      case "job": return { ok: true, job: { number: p.number, customer: "Test Customer", address: "1319 Pottstown Pike", description: "" } };
      case "place": return { ok: true, message: "✅ Order logged.", lines: 1, sms_text: "PO # 49370 ...", quickpad: "PEX34ELL\t2", weinstein: null };
    }
    return { ok: false, error: "Unknown action." };
  },
  clock(p) {
    if (p.token !== GOOD) return { ok: false, error: "That access code isn’t valid." };
    switch (p.action) {
      case "init": return { ok: true, who: "Kyle Hunt", today: TODAY, jobs: [{ id: "job_49370", number: "49370", customer: "Test Customer", address: "1319 Pottstown Pike, West Chester", start: "", start_text: "9:00 AM", status: "scheduled", hcp: { omw: "", start: "", finish: "" } }] };
      case "job": return { ok: true, job: { id: "job_" + p.number, number: p.number, customer: "Test Customer", address: "1319 Pottstown Pike", start_text: "", hcp: {} } };
      case "stamp": return { ok: true, message: "✅ START recorded for job " + p.number, job: { number: p.number, hcp: { start: "Fri 9:05 AM" } }, event: p.event };
      case "note": return { ok: true, message: "✅ Note added." };
      case "lineitem": return { ok: true, message: "✅ Line added." };
      case "photo": return { ok: true, message: "✅ Photo added." };
      case "catalog": return { ok: true, items: [{ uuid: "s1", name: "Hose Bib Replacement", category: "Outdoor", description: "", price: 32500, cost: 4000 }, { uuid: "s2", name: "Shutoff Valve - 1/2in", category: "Valves", description: "", price: 18500, cost: 2000 }] };
      case "lines": return { ok: true, job_id: p.job_id, number: p.number, lines: [], total: 0 };
      case "photos": return { ok: true, job_id: p.job_id, number: p.number, expanded: true, items: [{ id: "a1", name: "before.jpg", url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", type: "image/jpeg", image: true }, { id: "a2", name: "permit.pdf", url: "https://example.com/permit.pdf", type: "application/pdf", image: false }] };
      case "search": return { ok: true, items: [] };
    }
    return { ok: false, error: "Unknown action." };
  },
  jobInputs(p) {
    if (p.token !== GOOD) return { ok: false, error: "That access code isn’t valid." };
    switch (p.action) {
      case "init": return { ok: true, who: "Kyle Hunt", pending: 2, pending_jobs: 1, sheet_url: "https://docs.google.com/spreadsheets/d/x" };
      case "preview": return { ok: true, groups: [{ state: "ready", ref: "49370", job: { id: "job_49370", number: "49370", customer: "Test Customer", status: "complete rated", scheduled: "Oct 28" }, items: [{ k: "add", use: true, part: "PEX34ELL", name: "3/4 PEX ELBOW", qty: 2, cents: 99, total: 198, order: "S100", date: "10/28/2026", keys: ["k1"], payload: {}, reason: "" }] }], counts: {} };
      case "apply": return { ok: true, message: "✅ Posted 1 line to 1 job.", posted: 1, netted: 0, saved: 0, failed: 0, results: [{ ok: true, ref: "49370", count: 1 }] };
      case "receipt": return { ok: false, error: "not in mock" };
    }
    return { ok: false, error: "Unknown action." };
  },
};

/** Installs the route on a Playwright page. `state.online` false → every Apps Script call fails like no signal;
 *  `state.delay` (ms) → every call answers that late. */
async function install(page, configJsPath, state, log) {
  const byUrl = endpointKeys(configJsPath);
  await page.route("https://script.google.com/**", async route => {
    const req = route.request();
    const url = req.url().split("?")[0];
    const key = byUrl[url] || "";
    if (log) log.push({ key, method: req.method(), body: req.postData() || "" });
    if (!state.online) return route.abort("internetdisconnected");
    let p = {};
    try { p = JSON.parse(req.postData() || "{}"); } catch (e) {}
    const h = handlers[key];
    if (!h) return route.fulfill({ status: 404, body: "no such endpoint" });
    if (state.delay) await new Promise(r => setTimeout(r, state.delay));   // a slow server, to check what shows before it answers
    const out = h(p);
    if (key === "notes") return route.fulfill({ status: 200, contentType: "text/plain", body: out.text });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
  });
}

module.exports = { install, GOOD, TODAY };
