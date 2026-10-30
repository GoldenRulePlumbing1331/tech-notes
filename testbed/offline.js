/* Offline behaviour of every page. Usage: node offline.js <root> <outdir>
 *  1. With the backend mocked and online: open each page once (so a real browser would have it cached).
 *  2. Backend "no signal": reload each page — does the app stay usable, or does it kick the tech to the code screen?
 *  3. Service worker: with the real sw.js, visit every page online, then go fully offline and open each page again. */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const mock = require("./mock");

const ROOT = process.argv[2], OUT = process.argv[3], PORT = 8766;
const PAGES = ["home.html", "index.html", "new-job.html", "dispatch.html", "estimate.html", "order.html", "clock.html", "board.html", "job-inputs.html"];

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
  console.log(out.join("\n"));
  await browser.close(); srv.kill();
})();
