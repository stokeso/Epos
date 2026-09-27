# Club EPOS

A browser-based till (EPOS) for a golf-club bar, built as a **learning project**.

> **Not for real takings.** Club EPOS models how a club bar till works (selling, club pricing, tabs, deposits, stock, cash-up), but it has not been hardened for real trading, tax or security. Card payments are recorded, not processed. Read [Known limitations](#known-limitations) before you show it to anyone who might use it for real.

It runs entirely in the browser. Data is kept in IndexedDB on the device, and it is an installable Progressive Web App (PWA): once the production build has loaded, it works with no internet connection. It is designed for a **tablet in landscape** (1280 × 800) and a **phone in portrait** (390 × 844).

The source of truth is the design spec. This README is an overview that points into it and the other documents:

| Document | What it is for |
|---|---|
| [`docs/design-spec.md`](docs/design-spec.md) | What the till does and why: scope, data model, permissions, screens, pricing maths, tests. **Start here.** |
| [`docs/decisions.md`](docs/decisions.md) | Every ambiguity in the spec, resolved and numbered (`D-001`…). Worked examples with exact pence. Code comments cite these numbers. |
| [`docs/architecture.md`](docs/architecture.md) | How the spec maps onto modules: layers, import rules, services, data flows, Dexie tables, UI routes. |
| [`docs/ui-plan.md`](docs/ui-plan.md) | The UI reference: routes, shared components, Zustand stores, app helpers, styling tokens, e2e selectors. |
| [`CLAUDE.md`](CLAUDE.md) | Short working notes for AI agents working in this repository. |

---

## Features

Mapped to the in-scope list in spec §1.2.

| Spec §1.2 | What you get | Where |
|---|---|---|
| **Selling** | Category tabs and colour-coded product buttons, a basket (side panel on a tablet, bottom sheet on a phone), cash and card payments including split tenders, quick-cash £5/£10/£20/£50 and Exact buttons, change from cash only, a staff PIN login, and simulated receipt printing: an 80 mm till-roll receipt opens in a new browser tab, with an on-screen panel and **Reprint** if a popup blocker stops it. | Till, Pay |
| **Club pricing** | A member discount (15% by default) applied as soon as a member is attached; multi-buy deals (`n for £x` and `n for m`, e.g. "Any 2 bottles for £8", "Snacks 3 for 2"); deposits taken against a booking and offset against the final bill. | Till → Member / Booking; Back office → Deals, Settings |
| **Cash-up and reports** | X read (figures so far) and Z close (declared cash, expected cash, variance, Z number), each "printed" as an 80 mm document; product sales and VAT reports over a date range. | Period; Reports |
| **Stock and tabs** | Stock on hand derived from stock movements; goods in; adjustments and waste; a low-stock list that includes negative stock. Tabs opened by name or by table number, added to, reopened and settled. | Back office → Stock; Till → Tab; Tabs |
| **Back office** | Products, categories, deals, members, staff, bookings and settings (club name, receipt footer, auto-lock minutes, member discount %, receipt prefix). | Back office, Members, Bookings |
| **Three staff levels with PIN override** | Staff, supervisor and manager. An action above your level asks for a supervisor or manager PIN, which approves that one action and records both people in the audit log. | Everywhere (see [Permission levels](#permission-levels)) |
| **Local backup export/import** | Export everything to one JSON file; import validates the file and replaces all data only after you type `REPLACE`. A reminder appears for managers after 7 days without a backup. | Back office → Backup |

Also built in: refunds by receipt number (with return to stock or waste), auto-lock after a few idle minutes, a basket that survives a lock or a page refresh, and offline use.

---

## Running it

You need **Node.js 22.12 or later** (Vitest 5 requires it) and npm.

```bash
npm install
```

### Development server

```bash
npm run dev
```

Open the URL Vite prints (by default <http://localhost:5173>). The development server has hot reload but **no service worker**, so it does not work offline. A component gallery is available at `#/dev/components` in development only.

### Production build and preview

```bash
npm run build     # type-checks (tsc -b), then builds into dist/ with the service worker and manifest
npm run preview   # serves dist/ at http://localhost:4173
```

The built app precaches every screen, so after one visit it works with no connection.

### Installing as a PWA

1. Run `npm run build` and `npm run preview`, then open <http://localhost:4173> in Chrome or Edge.
2. Use the install icon in the address bar (or the install option in the browser menu). The app opens in its own window and starts offline from then on.

On a phone or tablet the same works from the browser's **Install app** / **Add to Home Screen** option, but only over **HTTPS** (or `localhost`): browsers only run service workers in a secure context, so `http://192.168.x.x:4173` over your Wi-Fi will load but won't install or work offline. To try it on a real tablet, host the `dist/` folder on any static HTTPS host. The app uses hash routes (`#/till`), so it needs no server rewrites. It must be served from the site root, because the manifest's `start_url` and `scope` are `/`.

### Starting again from scratch

All data lives in this browser profile's IndexedDB database `club-epos`. To reset, clear the site's data (in Chrome: DevTools → Application → Storage → **Clear site data**) and reload. You will be back at the setup screen.

---

## First run and sample logins

On a new device the app opens on **Set up this till**:

1. Enter the **club name**, your **manager name** and a **PIN** (4 to 6 digits, entered twice).
2. Tick **Load sample data** if you want something to play with (it is unticked by default).
3. Press **Set up till**. You are logged in as the manager and land on the till, which says **No trading period open**: selling is disabled until a period is open.
4. Press **Open period**, enter a float on the keypad (digits are pence, so `1`, `0`, `0`, `0`, `0` is £100.00) and confirm.

The sample data (decisions D-097 to D-100) adds 7 categories and 40 products (two of them at 0% VAT), two deals, 20 members numbered 1001 to 1020, two open bookings with no deposits, opening stock, and two extra staff accounts:

| Who | Role | PIN |
|---|---|---|
| The manager you created at setup | manager | the PIN you chose (the automated tests use "Morgan Manager", `1234`) |
| Sam Staff | staff | `1111` |
| Sue Supervisor | supervisor | `2222` |

When you load the sample data the manager's PIN may not be `1111` or `2222`, because PINs must be unique (D-075, D-099).

**Try a sale.** Tap **Birdie Pale Ale** twice (Bottles & Cans) and **Fairway Lager** once (Draught): the total is £12.80 after the "Any 2 bottles for £8" deal. Press **Member**, search `1001` and choose Alice Archer: the 15% member discount brings it to **£10.88**. Press **Pay**. Type `5`, `0`, `0` on the keypad and press **Card** to take £5.00 by card, then press **£10** for the cash: the change due is £4.12, and the receipt opens in a new tab. (This is the worked example in D-098.)

Then press **Lock** in the header, log in as Sam Staff (`1111`), add a couple of items and press **Void**. Choose the line and quantity and confirm: because staff can't void, a dialog asks for a "Supervisor or manager PIN", and `2222` approves that one void.

---

## Permission levels

Every role can open every screen and read every list (D-070). What is gated is the **action**: the button that writes data or produces a document.

| Action | Staff | Supervisor | Manager |
|---|:-:|:-:|:-:|
| Sell, take payment | ✓ | ✓ | ✓ |
| Open, add to, settle tabs | ✓ | ✓ | ✓ |
| Attach member | ✓ | ✓ | ✓ |
| Create booking, take deposit, apply deposit | ✓ | ✓ | ✓ |
| Void a basket line | — | ✓ | ✓ |
| No sale (open drawer) | — | ✓ | ✓ |
| X read | — | ✓ | ✓ |
| Refund | — | — | ✓ |
| Open period, Z close | — | — | ✓ |
| Edit products, prices, categories, deals | — | — | ✓ |
| Goods in, stock adjustment | — | — | ✓ |
| Manage members, staff, settings | — | — | ✓ |
| Product sales and VAT reports | — | — | ✓ |
| Export / import backup | — | — | ✓ |

- **Override.** When you try an action above your level, a dialog asks for a "Supervisor or manager PIN" or a "Manager PIN". A PIN of a high enough level approves **that one action only**; an `override` audit event records both people (spec §5, D-071, D-072).
- **The check is one pure function**, `can(role, action)` in [`src/rules/permissions.ts`](src/rules/permissions.ts). The UI asks through one helper, `requirePermission(action)` in [`src/app/requirePermission.ts`](src/app/requirePermission.ts), which returns an `Authorisation` (directly, or after an override). The screen passes it to exactly one service call, which checks that it is for that action and writes the `override` audit event in the same transaction as the action itself.
- **Wrong PINs.** Login and override share a count: after 5 wrong PINs in a row the keypad locks for 30 seconds (D-076).
- **Auto-lock.** The till locks after `autoLockMinutes` without a tap (default 5; a manager can change it in Settings). The basket and any payment in progress survive the lock (D-078).

---

## Architecture in brief

Three layers, each depending only on the one below (spec §3). Application use cases sit between the screens and the rules, so the screens hold no business logic and every use case can be tested without a browser.

```
src/app                  composition root: router, shell, guards, auto-lock, override dialog, bootstrap
  │
src/screens, src/components, src/store     React + Zustand: display state, pass on user actions
  │
src/services             use cases: the only place rules and repositories meet
  │           │             │
src/rules   src/receipt   src/seed         pure maths │ 80 mm HTML documents │ sample data
  │
src/data                 entity types, repository interfaces (repos.ts), errors, outbox, backup validation
  └─ src/data/local      Dexie / IndexedDB LocalAdapter: the only code that imports Dexie
```

The ideas worth studying:

- **Integer pence everywhere.** Money is a whole number of pence; there are no floating-point amounts. Every multiply-then-divide (member discount, VAT, spreading a deal saving across units) goes through the BigInt-backed round-half-up helpers in [`src/rules/money.ts`](src/rules/money.ts) (D-001 to D-005). The rules are written test-first against worked examples with exact expected pence.
- **Pure rules.** [`src/rules`](src/rules) has no React, no storage and no clock reads: times are passed in. Pricing is recalculated from scratch whenever the basket changes and frozen when Pay opens (D-011). ESLint enforces the purity and the Dexie rule ([`eslint.config.js`](eslint.config.js)).
- **Append-only sales and stock.** Sales and stock movements are never edited or deleted. A refund is a new sale with negative lines that references the original; stock on hand is the sum of a product's movements; a void before payment writes an audit event, not a sale. A sale and all its stock movements, its receipt number and its outbox entries are written in one transaction, so a failure leaves nothing behind (D-056).
- **The outbox.** Every record write also appends an entry (`entity`, `entityId`, `operation`, the full `payload`, `syncedAt: null`) to a local outbox in the same transaction (D-053, D-054). v1 only writes it; a future sync adapter would push it.
- **The repository contract suite.** Screens and services depend only on the interfaces in [`src/data/repos.ts`](src/data/repos.ts). One shared suite, `runRepositoryContract` in [`tests/data/contract.ts`](tests/data/contract.ts), defines what any adapter must do: create and read every entity, append-only rules, stock derived from movements, one outbox entry per write, one transaction per sale (with a forced failure that must leave nothing behind), and an exact backup round trip. [`tests/data/local-adapter.test.ts`](tests/data/local-adapter.test.ts) runs it against the LocalAdapter.
- **One composition root.** [`src/app/bootstrap.ts`](src/app/bootstrap.ts) is the only place that constructs the adapter. It passes one clock and one id generator to both the adapter and the `ServiceContext` that every service receives (D-118), which is how the tests control time and ids.

**Follow a sale through the layers** (architecture §5.1): tapping a product updates the basket in the basket store, which asks `services/till.viewBasket` for prices (`rules/pricing.priceBasket`) and saves a draft. **Pay** calls `services/pay.openSalePayment`, which freezes the pricing. Each tender goes through `rules/tender.applyTender`. On completion, `services/pay.completePayment` validates the sale (`rules/sale.validateSale`), works out the stock movements and calls `repos.commitSale` (one transaction), then renders the receipt with `src/receipt`, and the UI opens it in a new tab.

### The Supabase path (spec §11, not built)

The data layer is shaped so it can later be swapped for Supabase with offline-first sync, without changing the screens or the pricing rules:

1. Write a `SupabaseAdapter` that implements `Repos` from `src/data/repos.ts`. It keeps reads and writes local and pushes outbox entries to Supabase when online.
2. Make it pass the same contract suite: add a test file that calls `runRepositoryContract` with the new adapter, as `tests/data/local-adapter.test.ts` does.
3. Construct it in `src/app/bootstrap.ts` instead of the LocalAdapter.

The v1 choices already allow for this (D-114): every record has a UUID `id`, `deviceId`, `createdAt` and `updatedAt`; append-only sales and stock movements only need de-duplication by `id`; editable records resolve conflicts last-write-wins on `updatedAt`; receipt numbers are unique per device through the device prefix (`3F9C-000042`). Still open: club-wide settings need a shared record, staff outbox payloads include PIN hashes, and PIN uniqueness across devices is not enforced.

---

## Testing

| Layer | Folder | Tool | What it covers |
|---|---|---|---|
| Rules | [`tests/rules`](tests/rules) | Vitest | Pure pricing, deals, member discount, VAT, tenders, refunds, cash-up, reports, permissions, validation. Every numeric example in `docs/decisions.md`, asserted to the penny, and the permission matrix. |
| Data and services | [`tests/data`](tests/data), [`tests/data/services`](tests/data/services) | Vitest + `fake-indexeddb` | The repository contract suite on the LocalAdapter, PIN hashing, backup validation, the seed data, and every use case run against a real adapter with a fixed clock, including a full shift whose X/Z figures must reconcile (D-042). |
| UI units | [`tests/unit`](tests/unit) | Vitest (+ jsdom, Testing Library) | Receipt HTML, the Zustand stores, shared components, app helpers. |
| End to end | [`tests/e2e`](tests/e2e) | Playwright | The eight journeys of spec §10.3 (`journeys-1-4.spec.ts`, `journeys-5-8.spec.ts`), a spec per screen package, offline use, and layout checks (no sideways scroll at 390 px). Every test runs at tablet landscape 1280 × 800 and phone portrait 390 × 844. |

At the time of writing there are over 1,100 Vitest tests and just over 100 Playwright tests (each run at both sizes).

### Commands

| Task | Command |
|---|---|
| All fast gates: type-check, lint, unit + data tests | `npm run check` |
| Type-check only | `npm run typecheck` |
| Lint only | `npm run lint` |
| Unit + data tests | `npm test` (watch mode: `npm run test:watch`) |
| One folder or file | `npx vitest run tests/rules` |
| End to end, both viewports | `CI=1 npx playwright test` |
| One e2e spec | `CI=1 npx playwright test tests/e2e/journeys-1-4.spec.ts` |
| Parallel e2e runs | `CI=1 PW_PORT=4180 npx playwright test` (any free port) |

How the Playwright setup behaves ([`playwright.config.ts`](playwright.config.ts)):

- It builds the app and serves it with `vite preview`. With `CI=1` it always builds fresh; without it, Playwright reuses a server that is already listening on the port, which may be an old build.
- On the default port 4173 it builds into `dist/` and writes results to `test-results/`. With `PW_PORT=<port>` it uses `dist-e2e-<port>/` and `test-results-<port>/` instead, so several runs can go side by side. Delete those folders when you are done (they are git-ignored).
- It launches the Chromium at `/opt/pw-browsers/chromium` (the build machine's pre-installed browser). Set `PW_CHROMIUM_PATH` to point at another Chromium or Chrome executable. (Agents working in this repository: use the pre-installed browser and never run `playwright install`; see `CLAUDE.md`.)

---

## Project layout

```
docs/                design spec, decisions, architecture, UI plan
public/              favicon and PWA icons
src/
  main.tsx           entry point: renders <App/> and registers the service worker
  app/               router, shell, guards, auto-lock, override dialog, bootstrap, theme.css
  screens/           setup, login, till, pay, tabs, bookings, members, refunds, period, reports, backoffice
  components/        shared UI: keypads, modal, bottom sheet, basket panel, product button, data table…
  store/             Zustand stores: app, session, basket, pay, ui (screen and basket state only)
  services/          use cases: sale, pay, tabs, bookings, refunds, periods, stock, backup, staff…
  rules/             pure TypeScript: money, pricing, deals, discount, vat, tender, cashup, permissions…
  receipt/           80 mm receipt, X read and Z report HTML
  seed/              sample data
  data/              types.ts, repos.ts (interfaces), errors.ts, outbox.ts, backup.ts
    local/           Dexie schema and the LocalAdapter
tests/
  rules/             rules tests (test-first, exact pence)
  data/              contract suite, adapter, PIN, backup and seed tests
    services/        use-case tests against the LocalAdapter
  unit/              receipt, store and component tests
  e2e/               Playwright journeys and helpers
```

---

## Known limitations

This is a learning build. The main things that would need work before any real use:

- **PINs can be brute-forced from the device's storage.** A hashed 4 to 6 digit PIN stored on the device can still be brute-forced by anyone who can read that device's storage (spec §2). PBKDF2 uses 100,000 iterations and must be raised before real use (D-073). The wrong-PIN lockout is held in memory, so a refresh resets it (D-076). Backup files contain the PIN hashes and all takings (D-088): treat them as sensitive.
- **Card is recorded only.** Card payments are taken on a separate machine and recorded as the tender "Card". Nothing talks to a card terminal (spec §1.3).
- **No hardware.** There is no printer or cash drawer. Receipts and X/Z reports open as 80 mm pages in a new browser tab, and **No sale** only records an audit event and shows "Drawer opened". Past receipts and Z reports cannot be reprinted (D-109, D-047).
- **Single device.** There is no sync and the Supabase adapter is not built (spec §1.3, §11). Settings, trading periods, receipt numbers and Z numbers are per device, and only one app tab per device is supported (D-113).
- **The browser owns the data.** The app asks for persistent storage, and managers see a warning banner if the browser refuses; back up regularly (D-112, D-093).
- **A refresh during payment loses the tenders taken.** The basket comes back from the draft at the next login, but staff must hand back any cash or reverse any card payment already taken (D-033).
- **Smaller v1 gaps:** deposits cannot be refunded (D-024); there is no stock-take ("set count to N") (D-081); there is no audit-log screen (D-116); all times are Europe/London (D-102).
- **Out of scope for v1:** any connection to the club's live system, kitchen tickets, table plans, service charge or tips, loyalty points and gift cards (spec §1.3).
