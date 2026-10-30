/* Screenshots of every page with the access code set and the backend mocked (online). Usage: node shots.js <root> <outdir> */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const mock = require("./mock");

const ROOT = process.argv[2], OUT = process.argv[3], PORT = 8765;
const PAGES = ["home.html", "index.html", "new-job.html", "dispatch.html", "estimate.html", "order.html", "clock.html", "board.html", "job-inputs.html"];

(async () => {
  const srv = spawn("node", [path.join(__dirname, "serve.js"), ROOT, String(PORT)], { stdio: "inherit" });
  await new Promise(r => setTimeout(r, 600));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, serviceWorkers: "block", timezoneId: "America/New_York" });
  const errors = [];
  const state = { online: true };
  for (const pg of PAGES) {
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(pg + ": " + e.message));
    page.on("console", m => { if (m.type() === "error") errors.push(pg + " console: " + m.text()); });
    await mock.install(page, path.join(ROOT, "config.js"), state);
    await page.goto(`http://localhost:${PORT}/${pg}`);
    await page.evaluate(code => { localStorage.setItem("grTechCode", code); }, mock.GOOD);
    await page.reload();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, pg.replace(".html", ".png")), fullPage: true });
    await page.close();
  }
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
  await browser.close(); srv.kill();
})();
