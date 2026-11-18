/* Offline behaviour of every page. Usage: node offline.js <root> <outdir>
 *  1. With the backend mocked and online: open each page once (so a real browser would have it cached).
 *  2. Backend "no signal": reload each page — does the app stay usable, or does it kick the tech to the code screen?
 *  3. Service worker: with the real sw.js, visit every page online, then go fully offline and open each page again. */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const mock = require("./mock");

const ROOT = process.argv[2], OUT = process.argv[3], PORT = 8766;
const PAGES = ["home.html", "index.html", "new-job.html", "dispatch.html", "estimate.html", "history.html", "order.html", "clock.html", "board.html", "job-inputs.html"];

async function appState(page) {
  return page.evaluate(() => {
    const vis = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && !e.classList.contains("hidden"); };
    const codeCard = document.getElementById("codeCard");
    const app = document.getElementById("app");
    const err = (document.getElementById("codeMsg") || {}).textContent || "";
    const net = document.getElementById("grNet");
    return { codeCard: codeCard ? vis("codeCard") : null, app: app ? vis("app") : null, codeMsg: err.trim(), banner: net && vis("grNet") ? net.textContent.trim() : "", title: document.title };
  });
}

(async () => {
  const srv = spawn("node", [path.join(__dirname, "serve.js"), ROOT, String(PORT)], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 600));
  const browser = await chromium.launch();
  const out = [];

  // --- Part A: backend unreachable (page itself loads) ---
  {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block", timezoneId: "America/New_York" });
    const state = { online: true };
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await mock.install(page, path.join(ROOT, "config.js"), state);
    await page.goto(`http://localhost:${PORT}/home.html`);
    await page.evaluate(code => localStorage.setItem("grTechCode", code), mock.GOOD);
    for (const pg of PAGES) { await page.goto(`http://localhost:${PORT}/${pg}`); await page.waitForTimeout(900); }
    state.online = false;
    for (const pg of PAGES) {
      await page.goto(`http://localhost:${PORT}/${pg}`);
      await page.waitForTimeout(1500);
      const s = await appState(page);
      out.push(`A ${pg.padEnd(16)} app=${s.app} codeCard=${s.codeCard} msg="${s.codeMsg.slice(0, 60)}" banner="${s.banner.slice(0, 70)}"`);
      await page.screenshot({ path: path.join(OUT, "offlineA-" + pg.replace(".html", ".png")), fullPage: true });
    }
    if (errs.length) out.push("A page errors: " + errs.join(" | "));
    await ctx.close();
  }

  // --- Part B: service worker + fully offline ---
  {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "allow", timezoneId: "America/New_York" });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/home.html`);
    await page.evaluate(code => localStorage.setItem("grTechCode", code), mock.GOOD);
    await page.waitForTimeout(800);
    const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); if (!r) return "none"; await navigator.serviceWorker.ready; return r.active ? "active" : "installing"; });
    out.push("B service worker after first visit: " + sw);
    for (const pg of PAGES) { await page.goto(`http://localhost:${PORT}/${pg}`); await page.waitForTimeout(400); }
    await page.waitForTimeout(800);
    const cached = await page.evaluate(async () => { const keys = await caches.keys(); const c = await caches.open(keys[0] || "x"); const ks = await c.keys(); return keys.join(",") + " → " + ks.map(r => r.url.split("/").pop() || "(root)").sort().join(" "); });
    out.push("B cache: " + cached);
    await ctx.setOffline(true);
    for (const pg of PAGES.concat([""])) {
      let ok = true, why = "";
      try { await page.goto(`http://localhost:${PORT}/${pg}`, { timeout: 8000 }); await page.waitForTimeout(600); const s = await appState(page); why = `title="${s.title}" app=${s.app} codeCard=${s.codeCard} banner="${s.banner.slice(0, 60)}"`; }
      catch (e) { ok = false; why = e.message.split("\n")[0]; }
      out.push(`B offline ${(pg || "(root)").padEnd(16)} ${ok ? "loads" : "FAILS"} ${why}`);
    }
    await ctx.close();
  }
  // --- Part C: service worker serves the saved copy at once, and picks up a changed file ---
  {
    const fs = require("fs"), os = require("os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gr-sw-"));
    for (const f of fs.readdirSync(ROOT)) if (fs.statSync(path.join(ROOT, f)).isFile()) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    const srv2 = spawn("node", [path.join(__dirname, "serve.js"), tmp, String(PORT + 7)], { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 600));
    const base = `http://localhost:${PORT + 7}/`;
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "allow", timezoneId: "America/New_York" });
    const page = await ctx.newPage();
    await mock.install(page, path.join(ROOT, "config.js"), { online: true });
    await page.goto(base + "home.html");
    await page.evaluate(code => localStorage.setItem("grTechCode", code), mock.GOOD);
    await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForTimeout(1200);
    await page.goto(base + "new-job.html"); await page.waitForTimeout(800);
    // a new version ships: the page opens from the saved copy, then reloads itself once onto the new one
    fs.writeFileSync(path.join(tmp, "new-job.html"), fs.readFileSync(path.join(tmp, "new-job.html"), "utf8").replace("<title>New Job</title>", "<title>New Job v2</title>"));
    fs.appendFileSync(path.join(tmp, "gr-common.js"), "\nwindow.GR_V2 = true;\n");
    await page.goto(base + "new-job.html");
    const first = await page.title();
    await page.waitForTimeout(3000);
    const v2 = await page.evaluate(() => !!window.GR_V2);
    out.push(`C update: opened as "${first}", then "${await page.title()}" with new gr-common.js=${v2} ${first === "New Job" && (await page.title()) === "New Job v2" && v2 ? "OK" : "FAILS"}`);
    // a page the tech is already typing in is left alone; the update is there on the next open
    fs.writeFileSync(path.join(tmp, "estimate.html"), fs.readFileSync(path.join(tmp, "estimate.html"), "utf8").replace(/<title>[^<]*<\/title>/, "<title>Estimate v2</title>"));
    await page.waitForTimeout(31000);   // past the worker's "same update" window
    await page.goto(base + "estimate.html");
    const before = await page.title();
    await page.fill("#heard", "typing already"); await page.waitForTimeout(3000);
    const during = await page.title(), kept = await page.inputValue("#heard");
    await page.goto(base + "estimate.html"); await page.waitForTimeout(500);
    out.push(`C update while typing: "${before}" → stays "${during}" (text "${kept}") → next open "${await page.title()}" ${during === before && kept === "typing already" && (await page.title()) === "Estimate v2" ? "OK" : "FAILS"}`);
    await page.goto(base + "dispatch.html?job=1"); await page.waitForTimeout(600); await page.goto(base + "dispatch.html?job=2"); await page.waitForTimeout(600);
    const n = await page.evaluate(async () => { const c = await caches.open((await caches.keys())[0]); return (await c.keys()).filter(r => /dispatch\.html/.test(r.url)).length; });
    out.push(`C one saved copy per page whatever the ?query: ${n} ${n === 1 ? "OK" : "FAILS"}`);
    // the page's files held back 4 s by the network: the saved copy must show without waiting for them
    await ctx.route(base + "**", async route => { await new Promise(r => setTimeout(r, 4000)); route.continue().catch(() => {}); });
    const t0 = Date.now();
    await page.goto(base + "new-job.html", { waitUntil: "load" });
    const ms = Date.now() - t0;
    out.push(`C slow network: new-job.html loaded in ${ms} ms ${ms < 1500 ? "OK (saved copy, no wait)" : "FAILS (waited on the network)"}`);
    await ctx.unroute(base + "**");
    await ctx.close(); srv2.kill(); fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(out.join("\n"));
  await browser.close(); srv.kill();
})();
