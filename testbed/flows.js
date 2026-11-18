/* End-to-end flows with the backend mocked. Usage: node flows.js <root> */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const mock = require("./mock");
const ROOT = process.argv[2], PORT = 8767;
const U = p => `http://localhost:${PORT}/${p}`;
const results = [];
function ok(name, cond, detail) { results.push((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); }

(async () => {
  const srv = spawn("node", [path.join(__dirname, "serve.js"), ROOT, String(PORT)], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 600));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block", timezoneId: "America/New_York" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  page.on("dialog", d => d.accept());
  const state = { online: true }, log = [];
  await mock.install(page, path.join(ROOT, "config.js"), state, log);
  const txt = async sel => (await page.locator(sel).first().textContent() || "").trim();
  const vis = async sel => page.locator(sel).first().isVisible();

  // ---- access code: wrong code rejected, right code accepted, one code works everywhere ----
  await page.goto(U("home.html"));
  await page.fill("#code", "00000000"); await page.click("#codeGo"); await page.waitForTimeout(400);
  ok("home: wrong code rejected", /valid/.test(await txt("#codeMsg")), await txt("#codeMsg"));
  await page.fill("#code", mock.GOOD); await page.click("#codeGo"); await page.waitForTimeout(500);
  ok("home: right code opens the tiles", await vis("#app") && /Hi, Kyle/.test(await txt("#who")));
  ok("home: Customer History tile in the Estimate tile's place", (await page.locator('#tiles a[href="history.html"]').count()) === 1 && (await page.locator('#tiles a[href="estimate.html"]').count()) === 0 && !/Not connected/.test(await txt('#tiles a[href="history.html"]')));
  for (const pg of ["new-job.html", "dispatch.html", "estimate.html", "history.html", "order.html", "clock.html", "job-inputs.html", "board.html", "index.html"]) {
    await page.goto(U(pg)); await page.waitForTimeout(700);
    ok(pg + ": opens with the shared code", await vis("#app") && !(await vis("#codeCard")));
  }

  // ---- New Job: dictate → look up → pick → create ----
  await page.goto(U("new-job.html")); await page.waitForTimeout(600);
  ok("new-job: tech list from init", (await page.locator("#jEmp option").count()) === 4 && (await page.inputValue("#jEmp")) === "");
  await page.fill("#heard", "John Doe 12 Main Street West Chester leaking hose bib tomorrow at one");
  await page.click("#lookup"); await page.waitForTimeout(600);
  ok("new-job: match card shown", await vis("#matchCard") && /DoeJohn/.test(await txt("#matchList")));
  await page.click("#matchList .match"); await page.waitForTimeout(300);
  ok("new-job: confirm card filled", await vis("#confirmCard") && (await page.inputValue("#desc")) === "Leaking hose bib" && (await page.inputValue("#jType")) === "t1");
  ok("new-job: price-book line item ticked", (await page.locator("#liList .li input[type=checkbox]").first().isChecked()) && /\$325\.00/.test(await txt("#liSum")));
  ok("new-job: tag chip shown", /Water Heater/.test(await txt("#tagChips")));
  ok("new-job: photo section shown", await vis("#phSection"));
  await page.setInputFiles("#phFile", [{ name: "a.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==", "base64") },
                                       { name: "b.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==", "base64") }]);
  await page.waitForTimeout(500);
  ok("new-job: two photo thumbnails", (await page.locator("#phList .ph").count()) === 2);
  await page.click("#submit"); await page.waitForTimeout(1200);
  ok("new-job: job created", /Job 49999 created/.test(await txt("#doneMsg")), await txt("#doneMsg"));
  ok("new-job: photos sent to the job", /2 photos added to job 49999/.test(await txt("#phMsg")) && log.filter(l => l.key === "newJob" && /"action":"photo"/.test(l.body)).length === 2, await txt("#phMsg"));
  ok("new-job: form cleared after create", !(await vis("#confirmCard")) && (await page.inputValue("#heard")) === "" && (await page.inputValue("#desc")) === "" && (await page.locator("#liList .li").count()) === 0 && (await page.locator("#phList .ph").count()) === 0);
  await page.goto(U("new-job.html")); await page.waitForTimeout(600);
  ok("new-job: nothing from the last job after reopening", (await page.inputValue("#heard")) === "" && !/Picked up/.test(await txt("#talkMsg")));
  const create = log.filter(l => l.key === "newJob" && /"action":"create"/.test(l.body)).pop();
  const body = JSON.parse(create.body);
  ok("new-job: create payload has version + line items + customer", body.v === 7 && body.customer_id === "c1" && body.job.line_items.length === 1 && body.job.line_items[0].uuid === "s1" && body.req_id, JSON.stringify(body).slice(0, 160));
  ok("new-job: draft cleared after create", (await page.evaluate(() => localStorage.getItem("grDraft:newJob"))) === null);

  // ---- Dispatch: parse → change card → apply; board list ----
  await page.goto(U("dispatch.html")); await page.waitForTimeout(700);
  ok("dispatch: board loaded on open", /49370/.test(await txt("#boardList")));
  await page.fill("#heard", "Move 49370 to today at 1 give it to Mike"); await page.click("#go"); await page.waitForTimeout(600);
  ok("dispatch: change card with proposed time + crew", await vis("#changeCard") && (await page.inputValue("#cTime")) === "13:00" && (await page.locator("#crew input:checked").count()) === 1);
  await page.click("#submit"); await page.waitForTimeout(500);
  ok("dispatch: applied", /updated/.test(await txt("#submitMsg")), await txt("#submitMsg"));
  const apply = JSON.parse(log.filter(l => l.key === "dispatch" && /"action":"apply"/.test(l.body)).pop().body);
  ok("dispatch: apply payload", apply.job_id === "job_49370" && apply.change.employee_ids.join() === "e2" && apply.change.time === "13:00");

  // ---- Estimate: draft it → options editor → create ----
  await page.goto(U("estimate.html")); await page.waitForTimeout(600);
  ok("estimate: estimator defaults to me", (await page.inputValue("#jEmp")) === "e1");
  await page.fill("#heard", "John Doe 12 Main St option one replace the 50 gallon water heater"); await page.click("#lookup"); await page.waitForTimeout(600);
  ok("estimate: new-customer card (no match)", await vis("#confirmCard") && (await page.inputValue("#nFirst")) === "John");
  ok("estimate: option with line + total", (await page.locator("#options .opt").count()) === 1 && /2100\.00/.test(await txt("#options .total")));
  await page.fill("#naZip", "19380");
  await page.click("#submit"); await page.waitForTimeout(500);
  ok("estimate: created", /Draft estimate/.test(await txt("#submitMsg")), await txt("#submitMsg"));

  // ---- Customer History: search → pick → jobs, what was done, details on tap, estimates, saved for no signal ----
  await page.goto(U("history.html")); await page.waitForTimeout(600);
  const hInit = JSON.parse(log.filter(l => l.key === "estimate" && /"action":"init"/.test(l.body)).pop().body);
  ok("history: signs in through the Estimate script as its own tool", hInit.tool === "history" && (await page.evaluate(() => !!localStorage.getItem("grInit:history"))));
  await page.fill("#q", "nobody here"); await page.click("#go"); await page.waitForTimeout(400);
  ok("history: no match says so", /Nobody found/.test(await txt("#findMsg")) && !(await vis("#cust")));
  await page.fill("#q", "Doe"); await page.click("#go"); await page.waitForTimeout(400);
  ok("history: several matches → pick list", (await page.locator("#matchList .match").count()) === 2 && !(await vis("#cust")));
  await page.click("#matchList .match >> nth=0"); await page.waitForTimeout(500);
  ok("history: customer card with phone, address, notes", await vis("#cust") && !(await vis("#find")) && /DoeJohn/.test(await txt("#custCard .cname")) && (await page.locator('#custCard a[href="tel:6105551212"]').count()) === 1 && /Dog in the yard/.test(await txt("#custCard .cnote")) && (await page.locator("#custCard a.crow[href*='maps']").count()) === 2);
  ok("history: at-a-glance numbers", /33/.test(await txt("#stats .stat >> nth=0")) && /7,900\.00/.test(await txt("#stats")) && /350\.00/.test(await txt("#stats .stat.owe")) && /Next visit/.test(await txt("#warnMsg")));
  ok("history: jobs newest first, 25 at a time", /Jobs \(35\)/.test(await txt("#jobsTitle")) && (await page.locator("#jobList .jb").count()) === 25 && /Annual water heater flush/.test(await txt("#jobList .jb >> nth=0")) && /10 older/.test(await txt("#moreJobs")));
  ok("history: what was done shows on recent jobs without a tap", /frost-free hose bib/.test(await txt("#job-job_49370 .jw")) && /350\.00 owed/.test(await txt("#job-job_49370")));
  await page.click("#job-job_49370 .jh"); await page.waitForTimeout(400);
  ok("history: tap a job → line items, notes, photos, HCP link", /Hose Bib Replacement/.test(await txt("#job-job_49370 .jd")) && (await page.locator("#job-job_49370 .jph a").count()) === 2 && (await page.locator('#job-job_49370 .jd a.hcp[href$="job_49370"]').count()) === 1);
  await page.click("#addrChips .chip >> nth=2"); await page.waitForTimeout(200);
  ok("history: address chips narrow the list", /Jobs \(1 of 35\)/.test(await txt("#jobsTitle")) && /Sump pump install/.test(await txt("#jobList")));
  await page.click("#job-job_46500 .jh"); await page.waitForTimeout(400);
  ok("history: an older job loads its details on tap", /Zoeller/.test(await txt("#job-job_46500 .jd")) && /Installed a new 1\/2 HP sump pump/.test(await txt("#job-job_46500 .jd")));
  await page.click("#addrChips .chip >> nth=0"); await page.fill("#filter", "water heater"); await page.waitForTimeout(400);
  ok("history: filter box finds jobs by what they were", /Jobs \(2 of 35\)/.test(await txt("#jobsTitle")));
  await page.fill("#filter", ""); await page.waitForTimeout(300);
  await page.click("#moreJobs"); await page.waitForTimeout(200);
  ok("history: show more", (await page.locator("#jobList .jb").count()) === 35 && !(await vis("#moreJobs")));
  await page.click("#estList .opt button >> nth=0"); await page.waitForTimeout(400);
  ok("history: estimate with options; tap an option for its lines", /Estimates \(1\)/.test(await txt("#estTitle")) && /2,100\.00/.test(await txt("#estList .opt >> nth=0")) && /50 gal water heater/.test(await txt("#estList .opt .lines")));
  const hWrites = log.filter(l => l.key === "estimate" && /"tool":"history"/.test(l.body)).map(l => JSON.parse(l.body).action);
  ok("history: only read calls were made", hWrites.every(a => ["init", "search", "customer", "job", "option"].indexOf(a) !== -1), hWrites.join(","));
  await page.goBack(); await page.waitForTimeout(300);
  ok("history: phone back button returns to the search, lookup listed", await vis("#find") && !(await vis("#cust")) && /history\.html/.test(page.url()) && /DoeJohn/.test(await txt("#recentList")));
  state.online = false;
  await page.click("#recentList .match >> nth=0"); await page.waitForTimeout(500);
  ok("history: no signal → the saved copy still opens", await vis("#cust") && /No signal/.test(await txt("#custMsg")) && /Replace hose bib/.test(await txt("#jobList")));
  state.online = true;
  await page.goto(U("history.html?q=6105551212")); await page.waitForTimeout(900);
  ok("history: a single match opens straight away (also from ?q=)", await vis("#cust") && /DoeJohn/.test(await txt("#custCard .cname")));

  await page.goto(U("history.html?q=Doe&pick=DoeJane")); await page.waitForTimeout(900);
  ok("history: from a Board job with a shared phone, the job's own customer is asked for", JSON.parse(log.filter(l => /"action":"customer"/.test(l.body)).pop().body).customer_id === "c2");
  await page.goto(U("history.html?q=Doe&pick=SomeoneElse")); await page.waitForTimeout(900);
  ok("history: no clear pick → the list, nothing opened", (await page.locator("#matchList .match").count()) === 2 && !(await vis("#cust")));

  // ---- Order (WIP): parse shows review, Place stays disabled ----
  await page.goto(U("order.html")); await page.waitForTimeout(600);
  await page.fill("#heard", "Job 49370 pickup two 3/4 PEX elbows"); await page.click("#build"); await page.waitForTimeout(600);
  ok("order: review card with job + item", await vis("#reviewCard") && /49370/.test(await txt("#jobBox")) && (await page.locator("#items .item").count()) === 1);
  ok("order: place button still disabled (work in progress)", await page.locator("#submit").isDisabled());

  // ---- Job Inputs: CSV → preview → apply ----
  await page.goto(U("job-inputs.html")); await page.waitForTimeout(600);
  ok("job-inputs: pending note from init", /2 lines from earlier uploads/.test(await txt("#pendingNote")));
  const csv = '"Order Number","Ship Date","Customer PO#","Product #","Description","Comment","Quantity","Price","Ext Price","Qty UOM"\n"S100","10/28/2026","PO # 49370","PEX34ELL","3/4 PEX ELBOW","","2","0.99","1.98","EA"\n';
  await page.setInputFiles("#file", { name: "orders.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.waitForTimeout(800);
  ok("job-inputs: plan rendered", await vis("#planCard") && /1 line to add/.test(await txt("#chips")), await txt("#chips"));
  await page.click("#applyBtn"); await page.waitForTimeout(500);
  ok("job-inputs: applied", /Posted 1 line/.test(await txt("#applyMsg")), await txt("#applyMsg"));

  // ---- Job Clock: today's jobs, press Start online → sent ----
  await page.goto(U("clock.html")); await page.waitForTimeout(600);
  ok("clock: today's job listed", /49370/.test(await txt("#today")));
  await page.click("#today .job"); await page.waitForTimeout(200);
  await page.click('.big [data-ev="start"]'); await page.waitForTimeout(1500);
  ok("clock: press sent", /sent to the office/.test(await txt("#msg")) && (await page.evaluate(() => JSON.parse(localStorage.getItem("grClockOutbox") || "[]").length)) === 0, await txt("#msg"));

  // ---- Board: grid renders, sheet opens with field tools ----
  await page.goto(U("board.html")); await page.waitForTimeout(900);
  ok("board: columns + job block", (await page.locator("#grid .head").count()) >= 2 && (await page.locator("#grid .blk.job").count()) === 1);
  await page.click("#grid .blk.job"); await page.waitForTimeout(300);
  ok("board: job sheet with field tools", await vis("#sheet") && (await page.locator("#sheet .fb").count()) === 3);
  ok("board: job sheet links to the customer's history", (await page.locator('#sheet .acts a[href="history.html?q=6105551212&pick=CustomerTest"]').count()) === 1 && /Customer history/.test(await txt("#sheet .acts")));
  await page.fill("#sheet textarea", "Gate code 1234"); await page.click("#sheet .frow .btn"); await page.waitForTimeout(1200);
  const noteCall = log.filter(l => l.key === "clock" && /"action":"note"/.test(l.body)).pop();
  ok("board: private note sent through the clock script", !!noteCall && /Gate code 1234/.test(noteCall.body));
  ok("board: photos already on the job show in the sheet", (await page.locator("#sheet .jph a").count()) === 2 && (await page.locator("#sheet .jph a img").count()) === 1 && (await page.locator("#sheet .jph a.file").count()) === 1);

  // ---- OFFLINE: drafts survive, outboxes queue, home shows the badge, then flush when signal returns ----
  state.online = false;
  await page.goto(U("new-job.html")); await page.waitForTimeout(800);
  await page.fill("#heard", "Jane Roe 5 Oak Lane water heater not heating");
  await page.waitForTimeout(500);
  await page.goto(U("new-job.html")); await page.waitForTimeout(800);
  ok("offline new-job: dictation restored after reload", (await page.inputValue("#heard")) === "Jane Roe 5 Oak Lane water heater not heating" && /Picked up/.test(await txt("#talkMsg")));
  ok("offline new-job: lists still filled from the saved init", (await page.locator("#jEmp option").count()) === 4 && (await page.locator("#jType option").count()) === 2);
  await page.click("#lookup"); await page.waitForTimeout(600);
  ok("offline new-job: look up says no signal, text kept", /Couldn't reach|No signal/.test(await txt("#talkMsg")) && (await page.inputValue("#heard")).length > 10);

  await page.goto(U("index.html")); await page.waitForTimeout(600);
  await page.fill("#job", "49370"); await page.fill("#notes", "Replaced the hose bib and tested."); await page.click("#send"); await page.waitForTimeout(1200);
  ok("offline notes: saved to outbox", /No signal — saved/.test(await txt("#msg")) && await vis("#outboxCard") && (await page.locator("#outboxList .ob").count()) === 1);

  await page.goto(U("clock.html")); await page.waitForTimeout(800);
  ok("offline clock: today's jobs from the saved init", /49370/.test(await txt("#today")) && /No signal/.test(await txt("#jobMsg")));
  await page.click("#today .job"); await page.click('.big [data-ev="finish"]'); await page.waitForTimeout(1500);
  ok("offline clock: press queued", (await page.evaluate(() => JSON.parse(localStorage.getItem("grClockOutbox") || "[]").length)) === 1 && /saved with the right time/.test(await txt("#msg")), await txt("#msg"));

  await page.goto(U("home.html")); await page.waitForTimeout(800);
  ok("offline home: opens with badges", await vis("#app") && /1 waiting to send/.test(await txt("#tiles")));

  state.online = true;
  await page.goto(U("index.html")); await page.waitForTimeout(2500);
  ok("online again: queued note sent", /Saved notes sent/.test(await txt("#msg")) && !(await vis("#outboxCard")), await txt("#msg"));
  await page.goto(U("clock.html")); await page.waitForTimeout(2500);
  ok("online again: queued press sent", (await page.evaluate(() => JSON.parse(localStorage.getItem("grClockOutbox") || "[]").length)) === 0 && /sent to the office/.test(await txt("#msg")), await txt("#msg"));
  ok("online again: no-signal strip gone", !(await vis("#grNet")));

  // ---- Fast open: a repeat visit shows the app from the saved lists while the server check runs behind it ----
  state.delay = 2000;
  await page.goto(U("new-job.html")); await page.waitForTimeout(500);
  ok("fast open new-job: app + saved lists before the server answers", await vis("#app") && !(await vis("#codeCard")) && (await page.locator("#jEmp option").count()) === 4 && (await page.locator("#jType option").count()) === 2);
  await page.evaluate(() => { const k = "grInit:newJob", s = JSON.parse(localStorage.getItem(k)); s.r.employees = s.r.employees.slice(0, 2); localStorage.setItem(k, JSON.stringify(s)); });
  await page.goto(U("new-job.html")); await page.waitForTimeout(500);
  const early = await page.locator("#jEmp option").count();
  const picked = await page.evaluate(day => { const e = document.getElementById("jEmp"); e.selectedIndex = 2; document.getElementById("jDate").value = day; return e.value; }, mock.TODAY);   // (the confirm card is still hidden)
  await page.waitForTimeout(2300);
  ok("fast open new-job: server's lists replace the saved ones, picks kept", early === 3 && (await page.locator("#jEmp option").count()) === 4 && (await page.inputValue("#jEmp")) === picked && picked !== "" && (await page.inputValue("#jDate")) === mock.TODAY, early + " → " + (await page.locator("#jEmp option").count()));
  let mark = log.length;
  await page.goto(U("dispatch.html")); await page.waitForTimeout(600);
  ok("fast open dispatch: board asked for without waiting on init", log.slice(mark).some(l => /"action":"board"/.test(l.body)) && await vis("#app"));
  await page.waitForTimeout(2200);
  ok("fast open dispatch: board loaded once", log.slice(mark).filter(l => /"action":"board"/.test(l.body)).length === 1 && (await page.locator("#boardList .job, #boardList button, #boardList div").count()) > 0);
  for (const pg of ["home.html", "estimate.html", "order.html", "clock.html", "job-inputs.html"]) {
    await page.goto(U(pg)); await page.waitForTimeout(400);
    ok("fast open " + pg + ": app before the server answers", await vis("#app") && !(await vis("#codeCard")));
  }
  await page.goto(U("clock.html")); await page.waitForTimeout(400);
  ok("fast open clock: today's saved jobs shown at once", /49370/.test(await txt("#today")));
  // a code the office has revoked: the app shows from the saved lists, then the server's answer puts the code card back
  await page.evaluate(() => { localStorage.setItem("grTechCode", "11111111"); const k = "grInit:estimate", s = JSON.parse(localStorage.getItem(k)); s.c = "11111111"; localStorage.setItem(k, JSON.stringify(s)); });
  await page.goto(U("estimate.html")); await page.waitForTimeout(400);
  const shownEarly = await vis("#app");
  await page.waitForTimeout(2300);
  ok("fast open: a revoked code still ends on the code card", shownEarly && await vis("#codeCard") && !(await vis("#app")) && (await page.evaluate(() => localStorage.getItem("grTechCode"))) === null && (await page.evaluate(() => localStorage.getItem("grInit:estimate"))) === null, [shownEarly, await vis("#codeCard"), await vis("#app"), await page.evaluate(() => localStorage.getItem("grTechCode"))].join(" "));
  // a different code than the one the lists were saved under: no fast open, normal check
  await page.evaluate(code => localStorage.setItem("grTechCode", code), mock.GOOD);
  await page.evaluate(() => { const k = "grInit:order", s = JSON.parse(localStorage.getItem(k)); s.c = "22222222"; localStorage.setItem(k, JSON.stringify(s)); });
  await page.goto(U("order.html")); await page.waitForTimeout(400);
  const waited = !(await vis("#app"));
  await page.waitForTimeout(2300);
  ok("fast open: lists saved under another code aren't used", waited && await vis("#app"));
  state.delay = 0;

  // ---- Change code ----
  await page.goto(U("dispatch.html")); await page.waitForTimeout(600);
  await page.click("#forget"); await page.waitForTimeout(200);
  ok("forget: back to the code card everywhere", await vis("#codeCard") && (await page.evaluate(() => localStorage.getItem("grTechCode"))) === null);

  if (errs.length) results.push("PAGE ERRORS: " + errs.join(" | "));
  console.log(results.join("\n"));
  console.log(results.filter(r => r.startsWith("FAIL")).length + " failures / " + results.length);
  await browser.close(); srv.kill();
})();
