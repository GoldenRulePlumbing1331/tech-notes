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
const TODAY = "2026-10-30";
const GOOD = "12345678";

function job(n) {
  return { id: "job_" + n, number: String(n), customer: "Test Customer", company: "", phone: "6105551212", address: "1319 Pottstown Pike, West Chester",
    description: "Replace hose bib", status: "scheduled", scheduled: true, date: TODAY, time: "09:00", end_time: "11:00", duration_min: 120, arrival_min: 120,
    when: "Fri Oct 30, 9:00 AM–11:00 AM", employee_ids: ["e1"], employees: ["Kyle Hunt"], appointments: [], multi_day: false, tz: "America/New_York" };
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

/** Installs the route on a Playwright page. `state.online` false → every Apps Script call fails like no signal. */
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
    const out = h(p);
    if (key === "notes") return route.fulfill({ status: 200, contentType: "text/plain", body: out.text });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
  });
}

module.exports = { install, GOOD, TODAY };
