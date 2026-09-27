# Club EPOS — Architecture

**Status:** binding. Read `docs/design-spec.md` first, then `docs/decisions.md` (D-nnn). This file maps both onto modules, contracts and owners.

The contracts exist in code as types and implemented functions (they began as stubs that threw `Not implemented: <name>`; none remain). Each function's JSDoc gives the inputs, outputs and the decisions it implements:

- `src/data/types.ts`, `src/data/repos.ts`, `src/data/errors.ts`
- `src/rules/*.ts`
- `src/services/*.ts`
- `src/receipt/index.ts`, `src/seed/index.ts`
- `tests/data/contract.ts`

Keep these signatures stable. Amend a signature only when unavoidable, keep the change minimal, and note it in the station summary.

---

## 1. Layers and import rules

```
src/app  (composition root: router, shell, auto-lock, override dialog, bootstrap)
   │
   ├── src/screens, src/components, src/store   (React + Zustand; display and user actions)
   │        │
   │        ▼
   ├── src/services   (use cases: the ONLY place rules and repositories meet)
   │        │            │             │
   │        ▼            ▼             ▼
   │   src/rules     src/receipt    src/seed
   │   (pure maths)  (pure HTML)    (sample data + loader)
   │        │            │             │
   │        ▼            ▼             ▼
   └── src/data  (types.ts, repos.ts interfaces, errors.ts, backup.ts, outbox.ts)
            └── src/data/local  (Dexie LocalAdapter; the only Dexie importer)
```

| Folder | May import | Must NOT import |
|---|---|---|
| `src/data/*.ts` (not `local/`) | other `src/data` files | `src/rules`, `src/services`, `src/receipt`, `src/seed`, React, Zustand, Dexie |
| `src/data/local/**` | `dexie`, `src/data/*.ts` | rules, services, React |
| `src/rules/**` | other rules; `src/data/types.ts` (types and constants only) | React, Zustand, Dexie, `src/data/local`, `src/data/repos.ts` runtime, services, receipt, seed; **no clock reads** (`Date.now()`, `new Date()` without an argument) |
| `src/receipt/**` | `src/rules/**` (money, time, vat, permissions labels), `src/data/types.ts` | services, repos, Dexie, React |
| `src/services/**` | rules, receipt, `src/seed` (setup only), `src/data/types.ts`, `repos.ts` (types), `errors.ts`, `backup.ts` | Dexie, `src/data/local`, React, Zustand |
| `src/seed/**` | `src/data/*`, `src/services/pin.ts`, `src/services/context.ts` (types), rules | Dexie, `src/data/local`, React; `src/services/setup.ts` (would be a cycle) |
| `src/store`, `src/screens`, `src/components` | services, rules (pure display helpers: `formatPence`, `can`, validators, `formatDateTime`), `src/data/types.ts` and `errors.ts` (type/class only) | `src/data/local`, calling repositories directly, Dexie |
| `src/app/**` | everything above, including `src/data/local` for bootstrap only | Dexie directly |

ESLint enforces the Dexie rule and rules purity (see `eslint.config.js`). The rest of the table is enforced by review.

Rules of thumb:

- Money is integer pence everywhere, rounded only through `src/rules/money.ts` (D-001, D-002).
- Time: rules take ISO strings; services use `ctx.now()`; UI uses the context or `src/app/clock.ts` (D-101). The club zone is Europe/London (D-102).
- Every service write goes through one repository call or one `repos.transact()` (D-056). Never await non-repository promises inside `transact()`; hash PINs first.
- Errors are `AppError` with a `code` (D-117). Validators return `Validation<T>`; services turn failures into `AppError('VALIDATION', message, fieldErrors)`.

---

## 2. File ownership for the downstream builder stations

- rules builder: src/rules/**, tests/rules/** (may delete tests/rules/smoke.test.ts)
- data builder: src/data/** (types.ts and repos.ts may be amended minimally), src/services/pin.ts, tests/data/** EXCEPT tests/data/services/** and tests/data/seed*.test.ts (may delete tests/data/smoke.test.ts)
- services builder: src/services/** EXCEPT pin.ts, tests/data/services/**
- receipt & seed builder: src/receipt/**, src/seed/**, tests/unit/receipt*.test.ts, tests/data/seed*.test.ts
- UI (a later workflow): src/app/**, src/screens/**, src/components/**, src/store/**, tests/unit/** (other), tests/e2e/**

> Application services (use cases) live in src/services/ — they are the only way screens touch rules + repositories together, kept out of React so they are testable with the LocalAdapter under fake-indexeddb. Services receive their dependencies (repos, a clock, an id generator, device info) explicitly — design a small context object — so tests control time and ids.

How that context was designed: `ServiceContext {repos, now, newId, storage}` in `src/services/context.ts` (D-118). Device identity (deviceId, devicePrefix) is read from Settings through `repos`. `storage` is the `navigator.storage` port.

Build order. The rules and data stations can work in parallel. Services, receipt and seed need both. UI comes last.

- `src/receipt` uses rules/money, time and vat at runtime.
- `src/seed` uses `services/pin.ts` (data builder) and `repos.transact`.
- Services tests use the real rules and the LocalAdapter.
- Services and receipt/seed builders may write tests against the contracts before those land. Their suites go green once the dependencies are implemented.

---

## 3. Module map

### 3.1 Data layer (`src/data`), data builder

| File | Responsibility |
|---|---|
| `types.ts` | Every entity (spec §4) with base fields. Value types: `SaleLine`, `Tender`, `TabLine`/`BasketLine`, `SaleDealLine`. `AuditEvent` discriminated by `type` with typed `detail`. `OutboxEntry`, `Draft`, `BackupFile`/`BackupTables`. `Role`/`Action`. Constants: `ENTITY_NAMES`, `APPEND_ONLY_ENTITIES` (D-051; the contract suite checks those repos have no update or delete methods), `DB_NAME`, `SCHEMA_VERSION`, `BACKUP_FORMAT`. Create-input aliases (`NewX`, `NewSale`, `SaleStockMovementInput`) and `Patch<T>` semantics (D-050). |
| `repos.ts` | Repository interfaces: `EditableRepo<T>` for editable entities; append-only `SaleRepo`, `StockMovementRepo`, `AuditEventRepo` (no update/delete); `PeriodRepo` (`open`/`close`/`getOpen`); `SettingsRepo`; `OutboxRepo`; `DraftRepo`. The aggregate `Repos` adds `initialise`, `commitSale`, `transact`, `exportAll`, `importAll` and `close`. Also `AdapterOptions`, `RepoFactory` and `DeleteDatabase`. |
| `errors.ts` | `AppError`, `AppErrorCode`, `isAppError` (D-117). |
| `outbox.ts` | `buildOutboxEntry()`, used by adapters (D-053, D-054). |
| `backup.ts` | Pure backup-file validation: `parseBackupText`, `validateBackupValue`, `serialiseBackup`, limits (D-088, D-089). |
| `local/index.ts` | `createLocalAdapter(options)` and `deleteLocalDatabase(dbName)`. Dexie schema per §6 below. `local/` may be split into more files (for example `db.ts`, `repos/*.ts`). |
| `../services/pin.ts` | `generateSalt`, `hashPin`, `createPinCredentials`, `verifyPin`, `PIN_ITERATIONS` (D-073, D-074). |

### 3.2 Rules (`src/rules`), rules builder. All pure.

| File | Responsibility | Decisions |
|---|---|---|
| `money.ts` | `roundHalfUp`, `mulDivRoundHalfUp`, `allocate`, `negate`, `sumPence`, `assertPence`, `formatPence`, `pressMoneyKey`, `parsePoundsToPence`, `penceToPoundsText`, caps | D-001..D-007 |
| `time.ts` | `londonMidnight`, `addDays`, `londonDateOf`, `localDateRange`, `isInRange`, `dealWindowFromDates`/`datesFromDealWindow`, `formatDateTime`, `formatLocalDate`, `formatDuration`, `fileStamp` | D-012, D-101..D-103, D-129 |
| `deals.ts` | `isDealActiveAt`, `expandUnits`, `compareUnits`, `canonicalDealOrder`, `evaluateDeal`, `applyDeals` | D-012..D-018 |
| `discount.ts` | `memberDiscount` | D-019, D-020 |
| `vat.ts` | `lineVat`, `vatSummary`, `vatTotals`, `VAT_RATE_CHOICES` | D-021, D-022 |
| `pricing.ts` | `priceBasket`, `depositApplied`, `toSaleLines`; `PricingLine`/`PricedBasket` | D-008..D-011, D-023 |
| `basket.ts` | `BasketState`, `EMPTY_BASKET`, `addProduct`, `reduceLine`, `isBasketEmpty`, `hasNoLines`, `mergeLines` | D-008, D-063, D-085, D-095 |
| `tender.ts` | `startTendering`, `applyTender`, `tenderSequenceProblems`, `QUICK_CASH_PENCE` | D-029..D-031 |
| `sale.ts` | `validateSale`, `formatReceiptNumber`, `normaliseReceiptQuery` | D-032, D-035, D-059 |
| `refund.ts` | `isRefundable`, `refundedQuantities`, `refundableQuantities`, `cumulativeShare`, `cumulativeRefund`, `buildRefundLine`, `buildRefundSale`, `refundMagnitude` | D-035..D-038, D-125 |
| `stock.ts` | `stockMovementsForSale` (sale/refund/waste movements) | D-039, D-079 |
| `booking.ts` | `isAttachable`, `canTakeDeposit`, `canSettle`, `canCancel`, `canEdit`, `BOOKING_TYPE_LABELS` | D-026..D-028 |
| `cashup.ts` | `expectedCash`, `periodFigures`, `zFigures`; `PeriodFigures`/`ZFigures` | D-040..D-043 |
| `reports.ts` | `productSalesReport`, `vatReport` | D-044, D-045 |
| `permissions.ts` | `Role`, `Action`, `ROLE_RANK`, `MIN_ROLE`, `ACTIONS`, `ACTION_LABELS`, `can`, `minRoleFor`, `overridePrompt` | D-069, D-071 |
| `lockout.ts` | PIN failure lockout state machine | D-076 |
| `validation.ts` | Every form/entity validator, `Validation<T>` | D-013, D-026, D-058, D-064, D-073, D-077, D-080, D-081, D-105, D-111 |
| `backup.ts` | `isBackupDue`, `backupFileName`, `IMPORT_CONFIRMATION_WORD` | D-088, D-090, D-093 |

### 3.3 Services (`src/services`), services builder (except `pin.ts`)

| File | Use cases |
|---|---|
| `context.ts` | `ServiceContext`, `createServiceContext`, `nowIso`, `StoragePort` |
| `auth.ts` | `login`, `findStaffByPin`, `Session` |
| `override.ts` | `Authorisation`, `authoriseDirect`, `approveOverride`, `assertAuthorised`, `overrideEvents`, `auditActor` |
| `setup.ts` | `getBootState`, `completeFirstRun`, `DEFAULT_SETTINGS` |
| `periods.ts` | `getOpenPeriod`, `requireOpenPeriod`, `openPeriod`, `currentPeriodFigures`, `runXRead`, `prepareZClose`, `previewZClose`, `confirmZClose` |
| `till.ts` | `loadTillCatalogue`, `resolvePricingLines`, `viewBasket`, `voidLine`, `recordNoSale` |
| `pay.ts` | `openSalePayment`, `openDepositPayment`, `takeTender`, `completePayment`, `PaySession` |
| `tabs.ts` | `listOpenTabs`, `openNewTab`, `addBasketToTab`, `loadTab`, `parkTab` |
| `members.ts` | `searchMembers`, `memberLabel`, `listMembers`, `saveMember`, `setMemberActive` |
| `bookings.ts` | `listBookings`, `getBookingSummary`, `listAttachableBookings`, `saveBooking`, `settleBooking`, `cancelBooking` |
| `refunds.ts` | `findSaleForRefund`, `commitRefund` |
| `stock.ts` | `listStockLevels`, `listLowStock`, `stockHistory`, `recordGoodsIn`, `recordStockAdjustment` |
| `reports.ts` | `todayLocal`, `runProductSalesReport`, `runVatReport` |
| `catalogue.ts` | Categories, products (with priceChange audit) and deals: list/save/(de)activate/delete |
| `staff.ts` | `listStaff` (no hashes), `createStaff`, `updateStaff` |
| `settings.ts` | `getSettings`, `saveSettings` |
| `backup.ts` | `exportBackup`, `checkBackupFile`, `importBackup`, `isBackupReminderDue` |
| `storage.ts` | `requestPersistentStorage`, `checkPersistentStorage`, `shouldWarnAboutStorage` |
| `draft.ts` | `saveDraft`, `restoreDraft` |
| `receipts.ts` | `buildReceiptModel`, `renderSaleDocument` |

### 3.4 Receipt and seed, receipt & seed builder

| File | Responsibility |
|---|---|
| `src/receipt/index.ts` | `escapeHtml`, `itemRows`, `renderReceipt` (sale/deposit/refund), `renderXReport`, `renderZReport`; model types; `RECEIPT_CSP`, `DEPOSIT_VAT_NOTE` (D-107..D-110). The file may be split, but `index.ts` stays the public entry. |
| `src/seed/index.ts` | `sampleData()` (D-097..D-100 verbatim), `loadSampleData(ctx, {managerStaffId, today})`, `RESERVED_SAMPLE_PINS` |

### 3.5 Tests

| Path | Owner | Content |
|---|---|---|
| `tests/rules/*.test.ts` | rules builder | Test-first worked examples: every numeric example in decisions.md, and the permission matrix (§10.1) |
| `tests/data/contract.ts` | data builder | `runRepositoryContract(name, makeStore, deleteDatabase?)` (D-115) |
| `tests/data/*.test.ts` | data builder | `local-adapter.test.ts` runs the suite on the LocalAdapter; `pin.test.ts`; `backup-validation.test.ts` |
| `tests/data/services/*.test.ts` | services builder | Use cases against the LocalAdapter under fake-indexeddb with a fixed clock and sequential ids. Includes the D-042 period end to end. |
| `tests/data/seed*.test.ts` | receipt & seed builder | Counts, the catalogue matches D-097, opening stock, PINs verify |
| `tests/unit/receipt*.test.ts` | receipt & seed builder | `itemRows` sums, escaping, CSP meta, D-107 examples |
| `tests/unit/**` (other), `tests/e2e/**` | UI | Component tests; the Playwright journeys of §10.3 |

---

## 4. Key conventions shared by services

- **Signature shape:** `fn(ctx: ServiceContext, auth?: Authorisation, ...args)`. Writing services take an `Authorisation` and call `assertAuthorised(auth, '<action>')` first. Read services take no auth.
- **Override events:** `overrideEvents(auth, periodId)` returns `[]` or one `override` event. Append it in the same `transact()` as the action's own writes (D-072).
- **Actor fields:** records use `auth.staffId`. The action's own audit event uses `auditActor(auth)`.
- **Open period:** `requireOpenPeriod(ctx)` for everything in D-068. `commitSale` looks it up again in its transaction.
- **Validation:** `rules/validation.ts` → `AppError('VALIDATION', firstMessage, fieldErrors)`.
- **Pricing:** `resolvePricingLines(ctx, basket.lines)` + `repos.deals.list()` + settings → `priceBasket({... at: nowIso(ctx)})`.

---

## 5. Data flows for the key use cases

Notation: **UI** = screen/store (later workflow); **S** = service; **R** = pure rule; **D** = repository call; `[tx]` = one transaction.

### 5.1 Complete a sale (§6.3, §6.4; D-008..D-011, D-029..D-034, D-056, D-079)
1. **UI** Tap product → `R basket.addProduct` (only if a period is open). The store runs **S** `till.viewBasket` (display pricing at now) and **S** `draft.saveDraft`.
2. **UI** Pay → **S** `pay.openSalePayment(ctx, basket)`:
   - `requireOpenPeriod`, then check ≥ 1 line;
   - `resolvePricingLines`, `deals.list`, `settings.get`, `members.get`, `sales.bookingBalance`;
   - **R** `priceBasket(at = now)` gives the frozen `PricedBasket`, then **R** `startTendering(total)`.
3. **UI** Tender buttons → **S** `pay.takeTender` → **R** `applyTender`. A rejection shows its message. At `complete`, or at once when the total is 0, go to step 4.
4. **UI** `requirePermission('sell')` (always direct) → **S** `pay.completePayment`:
   - **R** `toSaleLines` builds the `NewSale`, then **R** `validateSale`;
   - **D** `products.get` for current `stockTracked`, then **R** `stockMovementsForSale`;
   - **D** `commitSale({sale, stockMovements, clearDraft: true})` `[tx: period → re-checks → receipt number → sale → movements → tab settle → draft delete → outbox]`;
   - **S** `receipts.renderSaleDocument`.
5. **UI** `openDocument(html)` (D-109). The basket store resets to `EMPTY_BASKET` and the pay store clears.
6. Failure → Pay stays open with its tenders and shows "Sale not saved: …" (D-034).

### 5.2 Take a deposit (§6.7; D-024, D-027)
1. **UI** Bookings → booking → "Take deposit" → money keypad amount.
2. **S** `pay.openDepositPayment(ctx, bookingId, amount)`: open period, booking `open`, amount 1..9,999,999, then `startTendering(amount)`.
3. Tenders as in 5.1 step 3, then **UI** `requirePermission('bookings')` → **S** `completePayment`:
   - `NewSale {kind:'deposit', lines:[]…}` → `validateSale`;
   - **D** `commitSale({stockMovements: [], clearDraft: false})`, which re-checks that the booking is open inside the tx.
4. The deposit receipt shows "Deposit balance now £X". The till basket is untouched.

### 5.3 Final bill with deposit applied (§6.7, §7.4; D-023, D-028, D-031)
1. **UI** Booking button → **S** `bookings.listAttachableBookings` (open, balance > 0) → select → `basket.bookingId` is set and the draft saved.
2. **S** `viewBasket` shows the "Deposit taken −£x" line.
3. Pay → `openSalePayment` re-reads the balance, and the deposit applied is frozen. When the total is 0: "Complete sale" with no tenders.
4. `commitSale` re-checks the booking is `open` and applied ≤ balance `[tx]` (`BOOKING_NOT_OPEN` / `DEPOSIT_EXCEEDS_BALANCE`).
5. Later: Bookings → "Mark settled" (enabled iff balance = 0) → **S** `bookings.settleBooking`.

### 5.4 Open, add to, park, reopen and settle a tab (§6.6; D-062..D-066)
- **New tab:** basket has lines, is not in tab mode, has no booking → choose Name/Table and a label → `requirePermission('tabs')` → **S** `tabs.openNewTab`: **R** `validateTabLabel` against **D** `tabs.listOpen`, then `[tx: tabs.create + draft.clear]`, and the basket is `EMPTY_BASKET`.
- **Add to tab:** pick an open tab → **S** `tabs.addBasketToTab`: **R** `mergeLines`, then `[tx: tabs.update + draft.clear]`.
- **Reopen:** Tabs screen (**S** `listOpenTabs`: repriced totals, time open, "On till") → **S** `tabs.loadTab` (the basket must be empty) → basket in tab mode → draft saved.
- **Park ("Save to tab"):** **S** `tabs.parkTab` → `[tx: tabs.update (or softDelete when there are no lines) + draft.clear]`.
- **Settle:** in tab mode, Pay → 5.1. `commitSale` sets the tab to `settled` in the same tx. The Tabs screen "Settle" button runs `loadTab` then `openSalePayment`.

### 5.5 Refund (§6.8; D-035..D-039)
1. **UI** Refunds → receipt number → **S** `refunds.findSaleForRefund`: **R** `normaliseReceiptQuery` → **D** `sales.getByReceiptNumber` → **D** `sales.listRefundsOf` → **R** `refundableQuantities`. The current `stockTracked` is looked up per line.
2. **UI** Per-line steppers (0..refundable), return/waste (tracked only) and the tender (default cash).
3. **UI** `requirePermission('refund')` → **S** `refunds.commitRefund`:
   - `requireOpenPeriod`, then reload the original;
   - `[tx: sales.listRefundsOf → **R** `buildRefundSale` → `validateSale` → `stockMovementsForSale` → commitSale(refund, clearDraft:false) (re-checks availability) + auditEvents.append([override?, refund{…}])]`. The refunds so far are read inside the transaction because the cumulative shares depend on them (D-037).
4. The refund receipt opens: "REFUND", "Refund of …".

### 5.6 Void with override (§5, §6.3; D-070..D-072, D-085)
1. **UI** Staff taps Void on a line → chooses a quantity (default the whole line) → `requirePermission('voidLine')`.
2. `can('staff','voidLine')` is false, so the override dialog asks for a "Supervisor or manager PIN" → **S** `override.approveOverride` (PIN check outside any tx) → `Authorisation {action, staffId: sam, approvedById: sue}`.
3. **S** `till.voidLine`: `requireOpenPeriod` → `[tx: auditEvents.append([override, void{productId, productName, qty, unitPricePence, tabId?}])]` → **R** `reduceLine` → the new basket.
4. **UI** The store replaces the basket, reprices and saves the draft. The Authorisation is dropped.

### 5.7 X read (§6.11; D-041, D-046)
`requirePermission('xRead')` → **S** `periods.runXRead`:
1. `requireOpenPeriod` → **D** `sales.listByPeriod`, **D** `auditEvents.listByPeriod` → **R** `periodFigures`.
2. If overridden, append the override event alone.
3. **receipt** `renderXReport` → **UI** `openDocument`.

### 5.8 Z close (§6.11; D-047, D-061)
1. **UI** "Z close" → `requirePermission('openClosePeriod')`. The wizard holds the Authorisation.
2. **S** `prepareZClose(ctx, basket)`: open period and empty basket, else `BASKET_NOT_EMPTY`; returns openTabCount, and the UI warns when > 0.
3. **UI** Money keypad for the counted cash → **S** `previewZClose` (expected, declared, variance).
4. "Confirm Z close" → **S** `confirmZClose`: **R** `periodFigures` + `zFigures` → `[tx: periods.close (assigns zNumber) + auditEvents.append([override?, zClose{…}])]` → `renderZReport` → **UI** `openDocument`.
5. **UI** The cached open period is cleared; the till shows "No trading period open".

### 5.9 Goods in and stock adjustment (§6.9; D-080, D-081)
- **Goods in:** form → `requirePermission('stockControl')` → **S** `stock.recordGoodsIn`: **R** `validateGoodsIn` → `[tx: stockMovements.add(goodsIn) + override?]`.
- **Adjustment or waste:** form → **S** `stock.recordStockAdjustment`: **R** `validateStockAdjustment` (signed qty) → `[tx: stockMovements.add + auditEvents.append([override?, stockAdjust{stockMovementId…}])]`.
- **Lists:** **S** `listStockLevels` (on hand via `onHandByProduct`) and `listLowStock` (**D** `stockMovements.lowStock`).

### 5.10 Backup export and import (§8; D-088..D-093)
- **Export:** `requirePermission('backup')` → **S** `backup.exportBackup`:
  1. One clock read, `now`.
  2. `[tx: settings.update({lastBackupAt: now}) + auditEvents.append([override?, backupExport{exportedAt: now}])]`.
  3. **D** `exportAll` → `BackupFile` → **R** `backupFileName` → `serialiseBackup`.
  4. **UI** downloads it through a Blob and `<a download>`.
- **Import:**
  1. **UI** file input → text and size → **S** `backup.checkBackupFile` (`parseBackupText` + summary).
  2. Show exportedAt, prefix, a different-device warning and row counts; the user types `REPLACE`.
  3. Import → `requirePermission('backup')` → **S** `importBackup`: **D** `importAll(file.tables, {auditEvents: [override?, backupImport]})` `[tx]`.
  4. **UI** Clear the session, the basket and the pay store → login.

### 5.11 First-run setup (§6.1; D-057, D-099, D-111, D-112)
1. **app/bootstrap** `createLocalAdapter({dbName: DB_NAME, now, newId})`; on failure, the full-screen storage error. Then `createServiceContext({repos, now, newId, storage: navigator.storage})`.
2. **S** `setup.getBootState`: 'setup' → Setup screen.
3. Submit → **S** `completeFirstRun`:
   - **R** `validateFirstRun` (with `RESERVED_SAMPLE_PINS` when loading samples) → `createPinCredentials`;
   - **D** `initialise` `[tx 1]`;
   - if ticked, **seed** `loadSampleData` (hash sample PINs first, then `[tx 2]`);
   - **S** `requestPersistentStorage`;
   - returns the manager `Session`.
4. **UI** Logged in → Till: "No trading period open" → "Open period" → `requirePermission('openClosePeriod')` (direct for the manager) → keypad float → **S** `periods.openPeriod` `[tx]`.

### 5.12 Login, auto-lock and draft restore (§6.2, §8; D-074, D-076, D-078, D-093, D-094..D-096, D-112)
1. **Boot:** **S** `checkPersistentStorage` (once per app start). `getBootState` returns 'login'.
2. **Login:** PIN keypad + Enter → **R** `lockoutRemainingMs` (keypad disabled while > 0) → **S** `auth.login` → Session, or **R** `recordPinFailure` with "PIN not recognised".
3. **After login:**
   - If the in-memory basket is empty → **S** `draft.restoreDraft` → toast if items were removed.
   - Navigate to `/pay` if a Pay session exists, else `/till`.
   - Managers: **S** `backup.isBackupReminderDue` and `storage.shouldWarnAboutStorage` banners (in flow, dismissible per login).
4. **Auto-lock** (`app/useAutoLock`):
   - `pointerdown`/`keydown` (capture) set lastActivity; a 1 s interval locks at `autoLockMinutes`.
   - Lock clears the session, cancels any open dialog and pending override, and discards unsaved forms.
   - It keeps the basket, the draft and the Pay session → `/login`.
5. **Refresh:** everything in memory is gone, and the basket comes back from the draft at the next login (the Pay session does not, D-033).

---

## 6. Dexie tables and indexes (LocalAdapter)

Database `club-epos` (`DB_NAME`), `db.version(SCHEMA_VERSION = 1)`. Store names equal `EntityName` values plus `outbox` and `draft` (D-116). **Booleans are not valid IndexedDB keys**, so `active` and `stockTracked` are never indexed; filter them in memory (the tables are small). Optional fields that are absent are simply not in an index.

| Store | Primary key | Indexes | Used by |
|---|---|---|---|
| `staff` | `id` | — | login, override, uniqueness (all in memory) |
| `categories` | `id` | — | |
| `products` | `id` | `categoryId` | catalogue lists |
| `deals` | `id` | — | pricing loads all |
| `members` | `id` | `memberNumber` | `findByNumber`; search filters in memory |
| `bookings` | `id` | `status` | attachable list |
| `tabs` | `id` | `status` | `listOpen` |
| `sales` | `id` | `&receiptNumber` (unique), `periodId`, `createdAt`, `bookingId`, `refundOfSaleId` | refunds lookup, X/Z, reports by range, booking balance, refunds of a sale |
| `stockMovements` | `id` | `productId`, `saleId` | on hand, history, contract checks |
| `periods` | `id` | — | `getOpen` / Z number scan (small table) |
| `auditEvents` | `id` | `periodId`, `type` | X/Z counts, e2e journey 5 |
| `settings` | `id` | — | single row |
| `outbox` | `++seq` | `&id`, `entity`, `entityId` | contract tests, future sync |
| `draft` | `id` | — | single row `'current'` |

Dexie schema string sketch:

```ts
db.version(1).stores({
  staff: 'id', categories: 'id', products: 'id, categoryId', deals: 'id',
  members: 'id, memberNumber', bookings: 'id, status', tabs: 'id, status',
  sales: 'id, &receiptNumber, periodId, createdAt, bookingId, refundOfSaleId',
  stockMovements: 'id, productId, saleId', periods: 'id', auditEvents: 'id, periodId, type',
  settings: 'id', outbox: '++seq, &id, entity, entityId', draft: 'id',
});
```

Implementation notes for the data builder:

- Use `table.add` for creates (never `put`) so a duplicate id rejects (D-115); map `ConstraintError` to `AppError('CONFLICT')`.
- Every write method runs in its own `db.transaction('rw', [table, outbox, …])`. Inside `transact()` it joins the outer transaction, which includes every table.
- Strip undefined-valued keys before writing. A `Patch` key with value `undefined` deletes the field (D-050).
- `commitSale` lists every table it touches in its transaction. `failSaleCommitAfterWrites` throws after the outbox writes.
- `importAll` uses `bulkAdd` inside one transaction over all 14 stores (13 backed up + draft).

---

## 7. UI plan (summary; `docs/ui-plan.md` is the detailed reference)

### 7.1 Routes (`createHashRouter`: works offline and needs no server fallback)

| Route | Screen (`src/screens/…`) | Notes |
|---|---|---|
| `#/setup` | `SetupScreen` | only while `getBootState` = 'setup' |
| `#/login` | `LoginScreen` | PIN keypad; lockout countdown |
| `#/till` | `TillScreen` | category tabs, product grid, basket panel (landscape) / bottom sheet (portrait), action bar: Member, Tab, Booking, Void, No sale; Pay under the basket total (Lock and Menu are in the shell header); "No trading period open" + Open period |
| `#/pay` | `PayScreen` | amount due, remaining, tenders list, quick cash, Exact, keypad, Cash, Card, Cancel payment / Back to basket, Complete sale (total 0) |
| `#/tabs` | `TabsScreen` | open tabs with total and time open; Load, Settle |
| `#/bookings`, `#/bookings/:id` | `BookingsScreen`, `BookingDetailScreen` | create/edit, take deposit, mark settled, cancel |
| `#/members` | `MembersScreen` | search; managers add/edit/deactivate |
| `#/refunds` | `RefundScreen` | lookup, lines, tender, return/waste |
| `#/period` | `PeriodScreen` | open period (float), X read, Z close wizard |
| `#/reports/product-sales`, `#/reports/vat` | `ProductSalesReportScreen`, `VatReportScreen` | date range + Run |
| `#/backoffice` | `BackOfficeMenu` | links below |
| `#/backoffice/products`, `/categories`, `/deals`, `/staff`, `/stock`, `/settings`, `/backup` | `backoffice/*` | the back-office "Members" and "Bookings" entries link to `#/members` and `#/bookings` |

Guards: no Settings/staff → `#/setup`; no session → `#/login`; after login → `#/pay` if a Pay session exists, else `#/till`. Navigation is never permission-gated (D-070).

### 7.2 Zustand stores (`src/store/`): screen and basket state only

| Store | State | Notes |
|---|---|---|
| `appStore` | `ctx: ServiceContext`, `bootState`, `settings` snapshot (clubName, autoLockMinutes), `openPeriod` cache, `storageStatus` | refreshed after settings or period changes |
| `sessionStore` | `session: Session \| null`, `pinAttempts: PinAttemptState`, `lastActivityMs`, dismissed banners | never persisted |
| `basketStore` | `basket: BasketState`, `view: BasketView \| null`, `pricing` flag | every change → `viewBasket` + `saveDraft`; survives lock |
| `payStore` | `session: PaySession \| null`, `keypadPence`, `committing`, `error` | survives lock; cleared on complete or cancel |
| `uiStore` | toasts, `receiptFallback`, pending override request (resolver), confirm dialogs | override dialog is cancelled on lock |

### 7.3 App shell and shared components
- `src/app/`:
  - `App.tsx`: router (the shell is `AppShell.tsx`). Do not rename `App` or change `main.tsx` without the UI station.
  - `bootstrap.ts`: adapter + context.
  - `clock.ts`: `nowIso`/`nowMs` via `Date.now()`.
  - `useAutoLock.ts`.
  - `requirePermission.ts`: `authoriseDirect` or the override dialog.
  - `OverrideDialog.tsx` (spec §3.1 puts it in `app/`).
  - `openDocument.ts`: Blob URL + `window.open` + fallback (D-109).
  - `Banners.tsx`: backup reminder and storage warning.
- `src/components/`:
  - `NumericKeypad` (money, digits-as-pence, D-006) and `PinKeypad` (4–6 digits + Enter, D-073);
  - `Modal`, `ConfirmDialog`, `Toast`, `Banner`, `BottomSheet`;
  - `ProductButton`, `CategoryTabs`, `BasketPanel`, `BasketLineRow`, `MoneyText` (uses `formatPence`);
  - `ReceiptFallbackPanel` (sandboxed `srcdoc` iframe + Reprint);
  - `SearchList`, `FormField`, `DataTable`.

### 7.4 Selectors for e2e (keep stable)
- Buttons by accessible name: `Pay`, `Void`, `No sale`, `Member`, `Tab`, `Booking`, `Exact`, `Cash`, `Card`, `£5`, `£10`, `£20`, `£50`, `Complete sale`, `Open period`, `X read`, `Z close`, `Confirm Z close`, `Lock`, `Enter`.
- `data-testid`: `basket-total`, `amount-due`, `remaining`, `change-due`, `member-badge`, `deposit-line`, `receipt-fallback`, `low-stock-list`.
- Documents: the popup page `<title>` is `Receipt {receiptNumber}` / `X read` / `Z report {n}` (D-108). The DB is `club-epos`, store `auditEvents` (D-116).
- Sample logins: manager `1234` (convention), staff `1111`, supervisor `2222` (D-099).
- Both viewports: tablet landscape 1280×800 and phone portrait 390×844. Banners are in flow (they never overlay buttons).
