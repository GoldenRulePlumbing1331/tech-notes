# Golden Rule voice tools — setup & test guide

> **Status (2026-10-14, 4:15 PM):** offline support is live — every page opens with no signal, and Job Notes
> queues and auto-sends (Job Summary script v8 dedupes by `req_id`). Direct submit to the Weinstein web store
> is built, tested against a fake store (31 backend + 9 page checks) and deployed as HCP Order v5 — needs
> `WEINSTEIN_USER`/`PASS` + a `verifyWeinstein` run (see the Weinstein section). Earlier: all three Apps Script projects are created, configured, authorized and
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

## Weinstein web store — direct submit (added 2026-10-14 afternoon)

The web store (shop.weinsteinwestchester.com, Epicor Eclipse) is a plain form site, so `hcp_order.gs` now
drives it the way a person would: **log in → Quickpad (`.partnumber` + qty) → cart → Standard Checkout
(PO #, ordered by, ship via, required date, instructions) → submit.** "Express Checkout" is never used.

**Script Properties (HCP Order project):**

| Property | Value |
|---|---|
| `WEINSTEIN_USER` / `WEINSTEIN_PASS` | web-store login. Best: a dedicated user made on the site (My Account → Edit Users) so the script's cart never collides with a person's. |
| `WEINSTEIN_MODE` | `off` = text/email only · `cart` = fill the cart, office checks out on the site · `submit` = hands-off, returns the Weinstein order # |
| `WEINSTEIN_CONFIRM_EMAIL` | optional extra confirmation email (defaults to `ORDER_TO`) |
| `WEINSTEIN_PHONE` | optional phone for the order (defaults to the company phone) |

**Rolling it out:**
1. Set the login + `WEINSTEIN_MODE = cart`. Run **verifyWeinstein** (logs in, reads the cart, changes nothing).
2. Run **testWeinsteinCart** → one 3/4 PEX elbow ($0.99) lands in the cart with the comment "TEST - IGNORE". Open
   the site, see it, empty the cart.
3. Place a real order from the phone in `cart` mode for a day — the office opens My Cart → Standard Checkout.
4. Flip `WEINSTEIN_MODE = submit`. (Optional dry run: `testWeinsteinSubmit` places a real $0.99 pickup order
   with PO "TEST - VOICE TOOL" once you flip the guard constant at the bottom of the script.)

**What the order carries:** PO # = `PO # <job>` / `TRUCK STOCK` / `SHOP STOCK` (same as before, so the weekly
CSV → HCP upload still matches); Ordered By = the tech; Ship Via = *PKS PICKUP SOLAR* or *Delivery (OT)* with the
job-site address when delivering to the job; Required Date from "tomorrow" / "Friday" / "10/16" (else today);
Shipping Instructions = tech, pickup/delivery, needed-by, note, and any lines that had no exact part number
("ALSO NEED …"). The done screen shows the Weinstein order # (or the cart link in `cart` mode); the Log sheet's
Status column and the HCP job note get it too. If the store is down or the login fails, the order is still
logged/emailed and the page falls back to **Text the counter**.

**Still true:** no Hajoca API; texting 610-436-0880 is the branch's own channel and stays as the backup;
SupplyZone's Quick Pad list is still offered on the done screen.

## No signal — what works offline (added 2026-10-14, 4:15 PM)

- **Every page opens with no signal** after its first visit: `sw.js` (a service worker, registered from
  `config.js`) keeps the pages + config/manifest/icon on the phone. Since 2026-10-16 pages load **network first**
  (fresh copy whenever there's signal, so an update shows up the first time a page is opened after it ships) and
  fall back to the saved copy offline or when the network takes over 4 seconds. Nothing from script.google.com is cached.
- **Job Notes queues and auto-sends.** Every note is saved to the phone's outbox before it is sent. No
  signal → "📶 No signal — saved", the form clears, and a *Waiting to send* card lists the note with
  Send now / Edit / Delete. It sends itself when the phone comes back online, when the page is reopened, and
  every minute while the page is open. Each note carries a `req_id`; the Job Summary script (v8) remembers
  answered ids for 3 days, so a note that reached HCP but never got its reply back is **not** posted twice
  (matters for "Add to details"). A real ❌ from the server (wrong job number, bad code) keeps the note in
  the card with the error until the tech fixes it with Edit. The home page shows "N waiting to send" on the
  Job Notes tile.
- **Voice typing needs a connection** — Chrome's "Tap to talk" fails offline (the page now says so and points
  to the keyboard's microphone key, which works offline once Gboard's offline English pack is downloaded).
- New Job, Estimate and Order still need signal to finish (Haiku parsing, customer/job lookup, part matching
  and the tech's review happen live). They open offline but their Build/Look up buttons say the server can't
  be reached; a "save the dictation and resume later" outbox for those is the natural next step if needed.

## Job Inputs — Weinstein CSV → HCP (added 2026-10-16)

**Live since 2026-10-19:** project "HCP Job Inputs" (owner golden.rule.calendar), setupSheet / verifyAccess / installDailyTrigger run, web app deployed, URL in config.js `jobInputs`.


Replaces `D:\Job_Uploads` (the Python scripts). Same rules, no laptop: the office opens **job-inputs.html**,
drops the Weinstein *Order History Detail* CSV on it, the page parses it in the browser (split on `","` so
unescaped inch marks don't break rows; comment rows skipped; `PO # 49040-1` → job number; `PO # return` →
original sale + job from the Comment), and **HCP Job Inputs** (`hcp_job_inputs.gs`) builds a plan:

| Line | What happens |
|---|---|
| Job finished (complete rated/unrated) | **Add** to the job's Job Inputs — name prefixed with the part #, description `Weinstein #<order> <ship date>`, unit cost = extension ÷ qty in cents |
| Vendor receipt instead of a Weinstein CSV (Amazon, Home Depot, SupplyHouse… as PDF / photo / Word .docx / Excel .xlsx / text) — added 2026-10-28 | Sent to the script, which has Claude Haiku (`ANTHROPIC_API_KEY` script property, same key as the Order tool) read it into the same line shape: vendor, order #, ship date, PO text, items. **Sales tax on the receipt is spread across the lines** so the posted cost is what was paid; shipping is not added. Dedupe tag `<Vendor> #<order> <date>`. Word / Excel files are unzipped by the script itself (`Utilities.unzip`) and turned into text — Word tables keep rows / columns, headers / footers included; every Excel sheet as tab-separated rows — before the same Claude read. Old .doc / .xls are refused with "Save As .docx / .xlsx or PDF". Items without a printed SKU get a readable stand-in part # (`AMZ-EZARC-CARBIDE-RECIPROC-SAW`). Routing for vendor receipts: a job number in the PO field → that job; **anything else** (Inventory, Office, Truck, "Drain Machines", a desk, or no PO at all) → the month's Inventory Management job, since it's stock / consumables / overhead either way. The **Amazon Business "Orders" report CSV** (Business Analytics → Orders → CSV) is read by the page directly, no Claude: per-item tax and promotions give the net cost, model / part numbers are kept (ASIN when there's none), rows repeated per payment record are reconciled against the order subtotal, the same item shipped twice becomes one line, quantity-0 (cancelled) rows are left out. |
| PO is inventory / truck / shop stock (`Inventory`, `TRUCK STOCK`, `Truck Restock`, `shop stock`, `Van 2`…) — added 2026-10-28 | **Add to the monthly job on the customer "Inventory Management"** — the customer's job whose scheduled (or created) date is in the order's ship month. Found automatically; each month just create the new job in HCP. Posts even while that job is still open; no $100 duplicate-part hold. A stock return nets on this month's inventory job, or last month's if it was bought there. No job for the month yet → waiting (retried every morning). Two jobs in a month → "type the one to use" on the page, or property `INV_2026-11 = <job #>`. Properties: `INVENTORY_CUSTOMER` (default Inventory Management; `off` disables), `INVENTORY_CUSTOMER_ID` (optional pin), `INVENTORY_START` (default 2026-10; earlier stock is only logged). `verifyAccess()` prints the customer it found and its jobs by month. |
| Job not finished / not in HCP yet | **Waiting** — saved in the sheet's *Pending* tab; `retryPending()` runs every morning and posts it once the job is complete, then emails `REPORT_TO` |
| Same order # + part # already on the job (tagged), or an untagged entry with the same part/qty/cost | **Skip** |
| Same part already on the job (any order) and the line is $100+ | **Held** — unticked; tick "upload anyway" if it really is a second one |
| Return | **Netted**: against a purchase in the same file first, then against the HCP entry (qty reduced in place, "(RETURNED)" at zero), by part # alone if there's exactly one candidate; otherwise flagged |
| Several segments (49040-1, 49040-2) for a bare 49040 | The one scheduled closest to the ship date (shown as "auto-picked segment") |
| Job canceled / no job number / unknown PO text | **Needs attention** — type the job # in the group's box and the plan refreshes |
| Stock / truck / shop PO | Listed under "not for a job", nothing posted |
| Job tagged in `WARRANTY_TAGS` (off by default) | Water-heater unit left off, accessories post |

**Apply all** is the default button: posts every ticked add/net line (one `bulk_update` per job), logs each
line in the *Posted* tab (so a re-upload or overlapping export skips it), and saves the waiting lines.
Replays are safe (`req_id`), and the script re-reads the job's inputs before posting so two tabs can't
double-add. There is still no API to delete a Job Input — fix mistakes in HCP; the description says which
order the line came from.

Morning retry (`retryPending`, 6–7 AM) works job by job: it posts each finished job as soon as it's checked, stops after ~4 minutes, saves the Pending tab in one write, and schedules `retryPendingContinue` a minute later to finish (up to 15 runs). One summary email when the whole list has been checked. (Before 2026-10-28 it checked everything first and posted at the end, so a long list hit Apps Script's 6-minute limit and nothing was saved.)

Setup: new Apps Script project **HCP Job Inputs** ← `hcp_job_inputs.gs`; properties `HCP_API_KEY`,
`TECH_CODES`, `REPORT_TO` (optional `REPORT_CC`, `WARRANTY_TAGS`); run `setupSheet()` → `verifyAccess()` →
`installDailyTrigger()`; deploy as web app (Execute as Me, Anyone) → URL into `config.js` as `jobInputs`.
Tested against a fake HCP: 7 backend checks (plan, netting, held, warranty, apply, replay, morning retry)
and 14 browser checks (real CSV parse → plan → untick → apply).

## New Job — price book line items + duplicate accounts (added 2026-10-16)

- **Line items from the price book.** The services price book is small (~105 items, checked 2026-10-16), so the
  script caches the whole list for 6 hours and hands it to Haiku with the dictation; Haiku picks items **by number**
  from your real names ("50 Gallon, Natural, Atmospheric (BW)", "Kitchen Sink Clog", "Toilet Installation - HO
  Supplied") plus up to 3 alternatives (other sizes / fuel / who supplies it). The confirm card shows them as tick
  boxes with the price: only items the tech clearly asked for are pre-ticked; alternatives are in a dropdown;
  quantity is editable; the search box matches the cached list locally and understands how techs talk ("gas" →
  Natural/Propane, "gal" → Gallon, "spigot" → Hose Bib, "backed up" → Clog, "HO" → Homeowner). On Create the job is
  made first, then `PUT /jobs/{id}/line_items/bulk_update` (append) adds the ticked items linked to the price book
  entry (`service_item_id` + `service_item_type: organizational`); if HCP rejects the link they go on as plain line
  items and the message says "(not linked to the price book entry)". There is no diagnostic / service-call item in
  the services price book today, so a "just look at it" visit gets no suggestion — add one in HCP and it shows up
  within 6 hours (or run `verifyAccess()` to refresh now).
- **Work that isn't in the price book** (added 2026-10-16, 2 PM): Haiku also returns any requested work it can't match
  (e.g. "repair a leak on a copper elbow joint") and the page shows it as a custom row with an editable name and a
  price box — entering a price ticks it. A typed search with no real match does the same. Custom rows post as plain
  line items (not linked, not taxable). The search now ignores weak partial matches (about half the words must be in
  the item name), so "gas line cap" no longer lands on a water heater.
- **Assign to** always starts on **Unassigned** (also after "Start another job"); pick a tech only when you mean to.
  The success message always says who it's assigned to, or "Unassigned".
- **ZIP is optional** (2026-10-16, 3 PM). A street + city with no ZIP is looked up — US Census address lookup
  first, then other HCP customers on the same street in the same town, then the town's ZIP when it has only one
  (zippopotam.us; e.g. Downingtown → 19335, while West Chester has several and is left blank) —  on the server when the dictation is read, on the page as soon as you leave the street/city box,
  and again on Create as a safety net. Not found → the address is sent without a ZIP (if HCP ever insists, the
  page says "type the ZIP"). Street + ZIP with no city fills the city the same way.
- **Display name** preview matches HCP: last name then first name, no spaces ("John Doe" → "DoeJohn"), even
  when a company is entered (HCP shows Jim Talarico at Parke Bank as "TalaricoJim"). HCP sets that name itself;
  the page now shows it the same way, including on the customer match cards.
- **Price book descriptions** go on the job word for word, line breaks included (the cached copy used to
  flatten them and cut them at 160 characters — 93 of the 105 services are longer than that).
- **Out-of-date pages are refused.** The page sends its version with every request (`v`); the script turns away
  anything older than `NJ.MIN_PAGE_VERSION` with "This New Job page is out of date on this phone — close it and
  open it again", and the page shows a Reload button. Job #49761 (Oct 16) was assigned to Kyle by a copy of the page
  that had been open since before that day's fixes.
- **Job tags** (2026-10-16, 4 PM). Haiku picks the 3 tags that best fit the work from the tags actually used on the
  last ~1,000 jobs (most used first), leaving out customer/office/request tags (Requested:, No Send:, Pipeline
  Automation, New Customer, neighborhoods, Website, Tenant, … — `NJ.TAG_SKIP_RE`, plus script property `TAG_SKIP`).
  The page shows them as chips (× to drop, type to add any other tag); on Create each one goes on the job with
  `POST /jobs/{id}/tags` and the message lists them. Building the tag list scans ~600 jobs (~15 s), so it's
  kept in script properties for 7 days (`NJ_TAGS_CACHE_*`); `verifyAccess()` refreshes it.
- **Display name on new customers — HCP's API can't set it** (confirmed Oct 20 on #49795: the `display_name`
  sent on create is silently ignored, and the customer object has no such field). The success message now says
  "Display name: set it to DoeJohn in HCP", with a **Copy** button and **Open the customer in HCP**.
- **Unassigned really means unassigned** (Oct 20). HCP put the creator on #49795 by itself even though the page sent
  no tech. After creating (and adding line items/tags) the script reads the job back; if anyone is on it and the
  page said Unassigned, it sends an empty dispatch list (`PUT /jobs/{id}/dispatch`) and checks again. The message
  says "(HCP added X by itself — taken back off.)", or a ⚠️ if HCP kept them. Every case is logged in script
  property `NJ_UNASSIGN_LOG` (last 20).
- **Parent / child accounts.** The public API has no field for HCP's "This customer bills to" link (checked
  2026-10-16 against the 24 Patrick Ave accounts: the customer object only carries `kind`, `tags`, `addresses`).
  What the tool can do: when two or more matches share a phone number or an address, each gets a
  "⚠️ N accounts share this phone or address" note with its created year and tags, an account tagged with one
  of `PARENT_TAGS` (default *Parent, Billing, Bill to*) is ranked first and badged "Billing account", and one
  tagged with `CHILD_TAGS` (default *Child, Sub-customer, Sub customer, Tenant*) is ranked last and badged
  "Sub-account". Tag the accounts in HCP once and the voice page will steer to the right one. Script
  properties `PARENT_TAGS` / `CHILD_TAGS` override the defaults.
- `verifyAccess()` now also refreshes the cached price book and runs a sample search. Tests: 7 backend + 10 browser checks.

## Board — the day by tech, made for a phone (added 2026-10-16)

`board.html` (tile "Board" on the home page) is a phone-sized version of HCP's desktop Schedule → Day view. It
uses the **Dispatch** web app (new action `day`), so there's nothing new to set up beyond deploying a new version
of the Dispatch script.

- **Grid**: one column per tech plus *Unassigned*, with the time down the left and a red line at the current time.
  Two columns fit across a phone; swipe sideways for the rest (the `⇔ 2/3/4` button fits more). Column headers stay
  put while you scroll and show the tech's job total, scheduled hours, stops — and, for today, **where they are**
  from the On my way / Start / Finish buttons: "● At SwoffordMichael · since 9:40", "➜ Driving to …", "Next 1p · …",
  "✓ All done". All-day items (Emergency Phone, anytime jobs) sit in a strip under the headers.
- **List**: the same day as one card per tech — easier to read on a small screen.
- **Techs ▾** opens a checklist of everyone with a check mark next to each name: tap names to switch columns on/off,
  **All** / **None** at the top, and a "Nothing scheduled" section (office staff, people off) you can tick to add an
  empty column. Choices are remembered on that phone. The chips under it are quick toggles for whoever has work that day.
- **Unassigned** is always the first column (like HCP), even on a day with none. **All unassigned (N)** opens every
  open job nobody is on: *Past — still open* (last 14 days), *Scheduled, no tech* by day for the next 90 days (a
  multi-day job's day with nobody dispatched counts), and *Needs scheduling*. Tap one for details, Move / reassign,
  or "Show that day on the board". Server action `unassigned`, cached 60 s.
- **Tap anything** for the details: customer, job #, status times, techs, address (opens Maps), phone (tap to call),
  amount, type, tags, **Open in HCP**, and **Move / reassign**, which opens Dispatch with the job already typed in
  (`dispatch.html?job=NUMBER`).
- ‹ › and the date step through days; Today jumps back. Today's board refreshes itself every 2 minutes while it's on
  screen; ⟳ forces a fresh pull. The last board is saved on the phone, so it opens instantly and still shows (marked
  "No signal") when there's no reception.
- Server side: jobs come from `/jobs?expand[]=appointments` (one entry per appointment that day, so multi-day jobs show
  "Day 2 of 3"; canceled jobs are left off; amounts are HCP cents ÷ 100), estimates from `/estimates`, and events
  (Emergency Phone, appointments, meetings) from `/events` with the repeat rule worked out (daily/weekly/monthly/yearly,
  every-N, first-Friday style, until/count; a week-long occurrence like the Emergency Phone rotation shows on every day
  it covers). The whole day is cached 60 s so several people watching don't multiply HCP calls.
- HCP holds ~1,700 events and reading them all takes ~20 s, so the script keeps a saved list (script properties
  `DP_EVENTS_*`: every repeating event + one-off events from the last 14 days on) and adds the 100 most recently
  changed events on every load. When the saved list is over 3 hours old the Board page quietly asks the script to
  re-read it (`events_sync`) and reloads. Run `syncEvents()` in the editor to force it.

## Things to watch (unverified until the real run)

1. Dispatch/schedule writes with a Company key (verifyAccess tells you).
2. Time zone on `PUT /jobs/{id}/schedule` (verifyAccess compares before/after).
3. `/api/price_book/services` reachability (verifyAccess tells you).
4. Board filtering by tech uses `employee_ids[]=` — if "Everyone" and a single tech show the same list, tell me.
5. `GmailApp` send: the first order from the deployed web app sends as golden.rule.calendar@gmail.com with
   the display name "Golden Rule Plumbing & Contracting".

The standalone `hcp_verify_voice_access.gs` from earlier is now redundant — each script has its own
`verifyAccess()`.

## Job Clock — live 2026-10-19
Project "HCP Job Clock" (owner golden.rule.calendar): setupSheet / verifyAccess / installWeeklyTrigger run (Monday 6–7 AM report), web app deployed, URL in config.js `clock`.

## End-to-end test on "Test Customer" — 2026-10-20
Every job tool was run against Test Customer (1319 Pottstown Pike) with Kyle as the tech. All passed:
New Job (unassigned kept, price-book lines, tags, schedule, new-customer display-name note), Job Notes
(replace/append), Dispatch (move/assign/unschedule), Board + Unassigned list, Job Clock (stamps, notes,
replay ignored), Estimate (with and without a visit time), Order preview (cart mode, nothing placed) and
Job Inputs (post, $150 duplicate held, re-upload skipped, return netted 2 → 1).

What HCP does on its own (not fixable from our side):
- Anything scheduled through the API gets the key owner (Kyle) put on it. New Job takes him back off
  automatically; on estimates HCP won't let go, so the Estimate tool warns instead.
- Once line items are added, HCP renames the job after the first line item. What was dictated stays in
  Private notes (the field is labelled that way in New Job now).
- The customer display name can't be set by the API — New Job shows the LastFirst name to paste in.
- Price-book matches only find parts that are in the 443-item Weinstein parts catalog (a flapper and a wax
  ring weren't).

## New Job updates — 2026-10-21
- **Customer search** casts a wider net: it also searches the house number on its own and the street with a
  run-in direction split off, and counts sound-alike names ("Krause" heard → Crouse found) and street spellings
  ("Eastwood Bank Way" = "E. Woodbank Way"). An address on the opposite side (W vs E) ranks lower. Same-name
  accounts that share a phone or address show as one card ("HCP has N accounts for this person").
- **Arrival window**: 30 min added. An 8:00 AM start defaults to 30 min (until a window is picked by hand); other
  times default to 2 hours. **Jobs are booked for 2 hours** (`DEFAULT_DURATION_MIN`).
- **+ Custom line item** (any name and price, not from the price book) and **+ Discount** ($ off, or % of the ticked
  lines). Discounts go on as HCP "fixed discount" lines; a % is worked out on the page and sent in dollars, named
  "Discount (10%)". HCP's own percent-discount lines didn't total reliably through the API (tested on #49804).
- **Billing address and display name can't be set through HCP's API** (tested Oct 21: a type sent on the address,
  an address sent with the new customer, or a display name on create/update are all ignored — every API address is
  a service address). For a new customer the success screen shows a "Finish the new customer in HCP" checklist:
  display name (with a Copy button) and tick "Set as billing" on the address, plus a button to open the customer.
- Test records from the Oct 21 checks to delete in HCP: customers "ZZBilling Test" and "ZZBilling2 Test", and the
  addresses "1 Billing Test A" / "2 Billing Test B" on Test Customer (gone when Test Customer is deleted). Job #49804
  now has ZZ test line items (also on the delete list already).

## Labor cost in HCP — the hybrid (2026-10-28)

HCP's **Labor cost** (job costing, profit margin, hours per tech) comes from one place only: each tech's
On my way / Start / Finish times in the HCP app × that tech's **fully loaded rate**. The public API can't write
those times, timesheets or labor cost, and anything posted through the API lands under Material/Service cost
instead — so HCP's buttons are the system of record and the Job Clock is the check.

**One-time setup in HCP (by hand, before trusting the numbers):**
1. Settings → Jobs → Costs & Materials: turn on **Travel and time on jobs** and **Show job costing breakdown**.
2. Team → each tech → pencil → **Pay**: base pay + Additional costs (taxes, insurance, benefits) = fully loaded
   rate. Rates are **not** applied to time tracked before they were set — do this first.
3. Techs press OMW / Start / Finish in the HCP app on every job (the page's Job Clock is a backup, not a
   replacement). Don't post labor as job inputs — it would count twice.

**What the Job Clock does now (`dailyReport` checks every morning 6–7 AM and emails every 3 business days, replacing
the Monday email):**
- Looks at every job due since the last email (at least the last 3 days) and emails REPORT_TO:
  - **No labor cost** — finished in HCP but no Start/Finish there, so it's costing $0 labor. When someone
    pressed the page buttons, the email gives the travel and job time to type into **Field Tech Details**
    (job → tech's row → Edit → Total Travel Time / Total Job Time) with a direct link; otherwise "ask the tech".
  - **Times differ** — HCP has times but a page press is 15+ min away from them.
  - **Still open** — the day is over and Finish was never pressed in HCP.
- The email's hidden `JOBCLOCK-DATA` block still feeds the Chrome `apply-job-clock-times` run if Claude is
  asked to type the times in.
- Setup: run `installDailyTrigger()` once in the Job Clock editor (it removes the Monday trigger). The last send
  date is script property `CK_LAST_REPORT`; `sendReportNow()` emails straight away and restarts the 3-day count;
  `weeklyReport()` is a manual 7-day sweep that doesn't.
