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
  for (const pg of ["new-job.html", "dispatch.html", "estimate.html", "order.html", "clock.html", "job-inputs.html", "board.html", "index.html"]) {
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
  await page.click("#submit"); await page.waitForTimeout(600);
  ok("new-job: job created", /Job 49999 created/.test(await txt("#submitMsg")), await txt("#submitMsg"));
  const create = log.filter(l => l.key === "newJob" && /"action":"create"/.test(l.body)).pop();
  const body = JSON.parse(create.body);
  ok("new-job: create payload has version + line items + customer", body.v === 6 && body.customer_id === "c1" && body.job.line_items.length === 1 && body.job.line_items[0].uuid === "s1" && body.req_id, JSON.stringify(body).slice(0, 160));
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
  await page.fill("#sheet textarea", "Gate code 1234"); await page.click("#sheet .frow .btn"); await page.waitForTimeout(1200);
  const noteCall = log.filter(l => l.key === "clock" && /"action":"note"/.test(l.body)).pop();
  ok("board: private note sent through the clock script", !!noteCall && /Gate code 1234/.test(noteCall.body));

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

  // ---- Change code ----
  await page.goto(U("dispatch.html")); await page.waitForTimeout(600);
  await page.click("#forget"); await page.waitForTimeout(200);
  ok("forget: back to the code card everywhere", await vis("#codeCard") && (await page.evaluate(() => localStorage.getItem("grTechCode"))) === null);

  if (errs.length) results.push("PAGE ERRORS: " + errs.join(" | "));
  console.log(results.join("\n"));
  console.log(results.filter(r => r.startsWith("FAIL")).length + " failures / " + results.length);
  await browser.close(); srv.kill();
})();
