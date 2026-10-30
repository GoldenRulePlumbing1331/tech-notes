# Page checks (no real HCP, no Google)

Runs the tech-notes pages under Playwright against a mock of the seven Apps Script web apps (`mock.js`).

    node flows.js ..        # 47 end-to-end checks: access code, every tool's main flow, then offline drafts/outboxes
    node offline.js .. out  # backend unreachable + fully offline through the service worker; screenshots in out/
    node shots.js .. out    # one full-page screenshot per page (for before/after comparison)

Needs Node with `playwright` and its Chromium. `..` is the repo folder.
