# Page checks (no real HCP, no Google)

Runs the tech-notes pages under Playwright against a mock of the seven Apps Script web apps (`mock.js`).

    node flows.js ..        # 64 end-to-end checks: access code, every tool's main flow, offline drafts/outboxes, then fast open
    node offline.js .. out  # backend unreachable, fully offline through the service worker, and how it serves + updates saved pages; screenshots in out/
    node shots.js .. out    # one full-page screenshot per page (for before/after comparison)

Needs Node with `playwright` and its Chromium. `..` is the repo folder.
