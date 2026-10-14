# Golden Rule voice tools — setup & test guide

> **Status (2026-10-14, 12:50 PM):** all three Apps Script projects are created, configured, authorized and
> deployed; `config.js` on the `voice-tools` branch has all five URLs. `verifyAccess()` passed on real HCP for
> all three (schedule/dispatch writes work with the Company key; time round-trips exactly; price book is
> searchable). The Weinstein Orders sheet exists with 443 parts from the HCP price book. Remaining: merge the
> `voice-tools` branch, update `HCP_API_KEY` in the HCP Lead Alert project and `D:\Job_Uploads\config.json`,
> delete `D:\tech-notes\apps-script\secrets.txt`, test on a phone. The step-by-step below is kept for
> reference / rebuilding.


Built overnight 2026-10-14. Three new voice tools plus a home page, each its own Apps Script project
(same pattern as Job Notes and New Job). Everything was exercised end to end against a fake HCP and a
fake Claude — 24 backend checks and 7 browser walkthroughs pass — but **nothing has touched your real
HCP yet**. That's what this morning is for.

| Tool | Page | Apps Script | What it does |
|---|---|---|---|
| Home | `home.html` | — | One access code for every tool, tiles, "recent on this phone" |
| Dispatch | `dispatch.html` | `hcp_dispatch.gs` | "Move 49370 to Thursday at 9, give it to Mike" → confirm → HCP updated. Board view per day/tech. |
| Estimate | `estimate.html` | `hcp_estimate.gs` | Describe the options → Haiku writes headings/descriptions, prices pulled from the price book → draft estimate in HCP (nothing sent to the customer) |
| Order Material | `order.html` | `hcp_order.gs` | Say the parts + job → Weinstein part numbers matched → logged, emailed, note on the job, and a one-tap **text to the counter** + Quick Pad list |

Also updated: `index.html` and `new-job.html` now link to the home page and read their URLs from the new
`config.js`. New files: `config.js`, `manifest.webmanifest`, `icon.svg`.

---

## Before anything else (2 min)

1. **Rotate the HCP API key.** The old one is in this chat's history. HCP → Settings → API → regenerate,
   then update it in `D:\Job_Uploads\config.json`, the Job Notes and New Job script properties, and use
   the new one below.
2. Open the **New Job** Apps Script project → Project Settings → Script Properties → copy the
   **TECH_CODES** value. You'll paste it into each new project so every tech's existing code works everywhere.

---

## Step 1 — Dispatch (≈10 min)

1. script.google.com (signed in as golden.rule.calendar@gmail.com) → New project → name it **HCP Dispatch**
   → paste `hcp_dispatch.gs` over the default `Code.gs`.
2. Project Settings → tick **Show "appsscript.json"** → in the editor open `appsscript.json` and set
   `"timeZone": "America/New_York"`. Save.
3. Script Properties:
   - `HCP_API_KEY` = new key
   - `ANTHROPIC_API_KEY` = your key
   - `TECH_CODES` = pasted from New Job
   - `DISPATCHERS` = *leave unset for now* (everyone can dispatch). Later: `TJ Lasco, Office` to restrict.
4. In the editor, set `TEST_JOB_NUMBER` (top of the file) to a **scheduled, single-day** job — one of
   tomorrow's. Run **verifyAccess** → authorize → read the Execution log.
   - It re-sends that job's current time + techs with notifications **off** — nothing changes, nobody is texted.
   - ✅ on both `PUT /dispatch` and `PUT /schedule` = we're good.
   - ❌ 401/403 on the writes = our Company key can't dispatch (the spec marks these "Application key").
     Then: email apideveloper@housecallpro.com asking for Application-key access, and the Dispatch page
     stays read-only (board works) until then.
   - The log prints "Job now reads: … (was …)" — **these must match**. If they're off by 4–5 hours, tell me;
     it means HCP wants local time instead of UTC on that endpoint (one-line fix).
5. Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone** → Deploy → copy the
   `/exec` URL → paste into `config.js` as `dispatch`.

## Step 2 — Estimate (≈8 min)

1. New project **HCP Estimate** → paste `hcp_estimate.gs`. Set the time zone as above.
2. Script Properties: `HCP_API_KEY`, `ANTHROPIC_API_KEY`, `TECH_CODES`. Optional:
   - `ESTIMATE_STYLE` = extra writing rules, one per line (defaults already say: plain language, say what's
     included/excluded, **drywall not repaired**, never invent prices/brands).
   - `BUSINESS_UNITS` = comma-separated names to offer, in order (same as New Job).
3. Run **verifyAccess** (read-only). Watch the price-book line:
   - ✅ "Price book services searchable" → prices pre-fill from the book.
   - ⚠️ not reachable → page still works; the tech types prices. (Same Application-key question as above.)
4. Run **testParse** to see a sample write-up in the log (uses Haiku; creates nothing).
5. Deploy as a web app → URL into `config.js` as `estimate`.

## Step 3 — Order Material (≈15 min)

1. New project **HCP Order** → paste `hcp_order.gs`. Set the time zone.
2. Script Properties:
   - `HCP_API_KEY`, `ANTHROPIC_API_KEY`, `TECH_CODES`
   - `ORDER_TO` = **your own email for now** (tjlasco@goldenruleph.com). Orders get emailed here while
     you test. See "Weinstein channel" below before pointing it at the branch.
   - `ORDER_CC` = optional office inbox
   - `SHOP_ADDRESS` = `1331 Pottstown Pike, West Chester, PA 19380`
3. Run **setupSheet** → authorize (Sheets + Drive + Gmail scopes) → log shows the new **"Weinstein Orders"**
   spreadsheet URL (Catalog + Log tabs).
4. Fill the catalog — run **importCatalogFromHcpPriceBook** (pulls every HCP price-book material that has
   a part number; your monthly cost refresh keyed those to Weinstein product #s, so this should be a good
   base). Optional extra: put some Weinstein *Order History Detail* CSVs in a Drive folder, set
   `CSV_FOLDER_ID` at the top of the script, run **importCatalogFromCsvFolder**. The **Aliases** column in
   the Catalog tab is free text — add words techs actually say ("sharkbite", "90", "street ell").
5. Run **verifyAccess** → it prints the top matches for "3/4 PEX ELL" so you can see the matcher working.
   Run **testParse** for a full sample order (uses Haiku; sends nothing).
6. Deploy as a web app → URL into `config.js` as `order`.

## Step 4 — GitHub (≈5 min)

In the **tech-notes** repo (GoldenRulePlumbing1331), add/replace these files from the `tech-notes/` folder:

- new: `home.html`, `dispatch.html`, `estimate.html`, `order.html`, `config.js`, `manifest.webmanifest`, `icon.svg`
- replace: `index.html`, `new-job.html` (only change: header links to home + URL read from config.js)

`config.js` already has the Job Notes and New Job URLs filled in; add the three new ones. Commit, wait a
minute for Pages, open `…/home.html` on your phone.

Tip: from the home page use the browser menu → **Add to Home screen** — it installs as "Golden Rule" with
its own icon and opens straight to the tiles.

---

## Step 5 — Test on your phone

Enter your access code once on the home page; every tool picks it up.

**Dispatch** (pick a real job you don't mind touching, e.g. a test customer):
- "Move 49370 to Thursday at 9 and give it to Mike" → check the proposed date/time/crew → **Update job**
  → open HCP's calendar and confirm the time and tech. The job gets a private note "Dispatch (voice, …)".
- "Add Dave to 49370" → only the crew changes (uses the dispatch endpoint, no time change).
- "What does Mike have tomorrow?" → board for that day. Tap a job on the board to move it.
- Type a base number of a segmented job (49040) → it lists 49040-1 / 49040-2 to pick from. Multi-day jobs
  show an appointment picker and go through the appointments endpoint.
- "Take off the schedule" asks to confirm, then the job goes back to needs-scheduling.
- Customer notification is **off** unless you tick the box (or say "let the customer know").

**Estimate**:
- "Estimate for John Smith, 123 Main Street. Option one, replace the 50 gallon gas water heater, includes
  permit and haul-away, we'll have to open the drywall behind it. Option two, Navien tankless with recirc."
- Tap **Draft it** (it doesn't auto-draft when you stop talking — estimates are long). Pick the customer,
  review each option: heading, description, qty/price/cost. A red price box = no price-book match — type it
  or tap **Search book**. **✨ Rewrite wording** re-runs Haiku on your edits.
- **Create draft estimate** → it appears in HCP as a draft; nothing goes to the customer.

**Order Material**:
- "Job 49370, pickup this afternoon: two three-quarter PEX elbows, a box of half-inch copper 90s, one 50
  gallon gas water heater" → check the job box, the part number picked for each line (dropdown shows the
  alternates), pickup/delivery, needed-by.
- **Place order** → logs to the sheet, emails `ORDER_TO`, adds a private note on the job, then shows:
  - **💬 Text the counter** — opens your SMS app to 610-436-0880 with the order already typed; you just hit send.
  - **Copy Quick Pad list** — part# + qty per line, for the SupplyZone app's Quick Pad.
- Say "truck stock" or "shop stock" instead of a job number for stock orders (PO text becomes TRUCK STOCK /
  SHOP STOCK — the same labels your weekly CSV upload already recognises). Job orders use `PO # 49370`,
  the exact format `upload_from_csv.py` matches on.

---

## Weinstein channel — what I found and what to decide

- **No API, no HCP integration.** Hajoca/Weinstein publish no ordering API. Their only field-service
  integration is ServiceTitan (West Chester is on it). HCP's supplier integrations are Reece and Watsco only.
- **SupplyZone** (the app you linked, formerly "OE Touch") is Innovo's native order-entry app on Hajoca's
  Epicor Eclipse ERP. Its **Quick Pad** takes part numbers + quantities. The web store
  (supplyweb.hajoca.com) also has **Quickpad** and **Upload Order File** (CSV/TXT — column format not
  published; the emailed `order.csv` is Part Number, Quantity, Description, which you can adjust once you see
  theirs).
- **The branch's own words:** "Just call or **text** us at 610-436-0880, Mon–Fri 7–4." That's why the page's
  main button is *Text the counter* — it's their channel, it comes from the tech's own phone, and nothing
  fragile sits in between.
- **Email** (purch411@hajoca.com is their published purchasing address) is published as a contact, not an
  order channel. **Ask the counter** whether they'll work orders from email. If yes → set `ORDER_TO` to that
  address and the voice page becomes fully hands-off. Until then, orders email you and the tech texts.
- Browser automation of the web store is possible (it's a plain form-based site) but fragile; I'd only go
  there if they say no to email and texting proves too slow.

## Things to watch (unverified until the real run)

1. Dispatch/schedule writes with a Company key (verifyAccess tells you).
2. Time zone on `PUT /jobs/{id}/schedule` (verifyAccess compares before/after).
3. `/api/price_book/services` reachability (verifyAccess tells you).
4. Board filtering by tech uses `employee_ids[]=` — if "Everyone" and a single tech show the same list, tell me.
5. `GmailApp` send: the first order from the deployed web app sends as golden.rule.calendar@gmail.com with
   the display name "Golden Rule Plumbing & Contracting".

The standalone `hcp_verify_voice_access.gs` from earlier is now redundant — each script has its own
`verifyAccess()`.
