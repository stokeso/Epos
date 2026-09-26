# Club EPOS (learning build) — Design Spec

**Date:** 26 September 2026
**Owner:** Olly
**Status:** Approved in conversation; awaiting written-spec review
**Build route:** Claude Code, using the assembly-line framework (researcher → architect → builder → tester → reviewer ⇄ fixer → shipper, gated on the reviewer's verdict)

---

## 1. Purpose and scope

A browser-based EPOS (till) for a golf-club bar, built as a **learning project**. It is not used for real takings. It models how a club bar till works: selling, club pricing rules, tabs, deposits, stock and end-of-day cash-up.

### 1.1 Success criteria

- A full bar shift can be run on it end to end: log in, sell, run tabs, take and use deposits, refund, X read, Z close with a cash declaration.
- Every figure on receipts and reports is correct to the penny, proven by automated tests.
- The data layer can later be swapped for Supabase with offline-first sync without changing the screens or the pricing rules.
- It works in a browser on a tablet in landscape and on a phone in portrait, with no internet connection.

### 1.2 In scope (v1)

- Selling: product buttons, basket, cash and card payments (including split), change, simulated receipt printing, staff PIN login
- Club pricing: 15% member discount via member lookup, multi-buy deals, deposits offset against a final bill
- Cash-up and reports: X read, Z close with declared cash, product sales report, VAT report
- Stock and tabs: stock levels via stock movements, goods in, adjustments, low-stock list; open tabs by name or table number
- Back office: products, categories, deals, members, staff, bookings, settings
- Three staff levels with PIN override
- Local backup export/import

### 1.3 Out of scope (v1)

- Integrated card payments. Card is taken on a separate machine and recorded as the tender "Card" only.
- Real printer or cash-drawer hardware
- Multi-device sync and the Supabase adapter (the design prepares for it; it is not built)
- Any connection to the club's live ClubV1 system
- Kitchen tickets, table plans, service charge/tips, loyalty points, gift cards

---

## 2. Technology

| Concern | Choice |
|---|---|
| Language | TypeScript, `strict` mode |
| UI | React, built with Vite |
| UI state | Zustand (screen and basket state only; persistent data lives in the data layer) |
| Local storage | IndexedDB via Dexie |
| Offline / installable | `vite-plugin-pwa` (service worker + web app manifest) |
| Unit tests | Vitest |
| Data-layer tests | Vitest + `fake-indexeddb` |
| End-to-end tests | Playwright (tablet landscape 1280×800, phone portrait 390×844) |
| PIN hashing | Web Crypto PBKDF2 with a random salt per staff member |

A hashed 4–6 digit PIN stored on the device can still be brute-forced by someone with access to that device's storage. This is acceptable for a learning build and must be revisited before any real use.

---

## 3. Architecture

Three layers. Each layer depends only on the one below it.

```
Screens (React components)
   │  display state, pass on user actions
   ▼
Rules (pure TypeScript functions — no storage, no React)
   │  pricing, deals, member discount, VAT, tenders, report totals, permissions
   ▼
Data layer (repository interfaces)
   ├─ LocalAdapter    — Dexie / IndexedDB   (v1)
   └─ SupabaseAdapter — offline-first sync  (future, same interfaces)
```

### 3.1 Folder structure

```
src/
  app/            routing, app shell, auto-lock, PIN override dialog
  screens/        login, till, pay, tabs, bookings, members, refunds, backoffice/*, reports/*
  components/     shared UI (product button, basket line, numeric keypad, modal)
  rules/          money.ts, pricing.ts, deals.ts, discount.ts, vat.ts, tender.ts, cashup.ts, permissions.ts
  data/
    types.ts      entity types shared by every adapter
    repos.ts      repository interfaces
    local/        Dexie schema + LocalAdapter
    outbox.ts     change log for future sync
    backup.ts     export/import
  seed/           sample data
  receipt/        receipt and X/Z report HTML templates (80 mm)
tests/
  rules/          unit tests
  data/           repository contract tests
  e2e/            Playwright journeys
```

### 3.2 Rules that keep the Supabase switch cheap

- Money is stored and calculated in **integer pence**. No floating-point amounts anywhere.
- Every record has `id` (UUID v4), `deviceId`, `createdAt` and `updatedAt`. Editable records also have `deletedAt` for soft deletes.
- **Sales and stock movements are append-only.** They are never edited or deleted:
  - a refund is a new sale with negative lines that references the original sale
  - voiding a line before payment removes it from the basket and writes an audit event; nothing is stored as a sale
  - stock on hand = the sum of that product's stock movements
- Every write also appends an entry to a local **outbox** (`entity`, `entityId`, `operation`, `payload`, `createdAt`, `syncedAt: null`). v1 only writes to it; the future sync adapter reads from it.
- Screens and rules never import Dexie directly. They use only the interfaces in `data/repos.ts`.
- One shared **repository contract test suite** runs against the LocalAdapter now. Any future adapter must pass the same suite.

---

## 4. Data model

Money fields are integer pence. VAT rates are whole-number percentages (20, 0).

| Entity | Key fields |
|---|---|
| **Staff** | name, role (`staff` \| `supervisor` \| `manager`), pinHash, pinSalt, active |
| **Category** | name, sortOrder, colour |
| **Product** | name, categoryId, pricePence (VAT-inclusive), vatRate, memberDiscountEligible, stockTracked, stockUnit (e.g. "bottle", "pint"), lowStockLevel, buttonColour, sortOrder, active |
| **Deal** | name, type (`nForPrice` \| `nForM`), n, pricePence (for `nForPrice`), m (for `nForM`), productIds[], active, startsAt?, endsAt? |
| **Member** | memberNumber, firstName, lastName, active |
| **Booking** | type (`wedding` \| `society` \| `eventTicket` \| `other`), name, date, notes, status (`open` \| `settled` \| `cancelled`) |
| **Tab** | labelType (`name` \| `table`), label, openedAt, openedBy, status (`open` \| `settled`), lines[], memberId? |
| **Sale** | receiptNumber, periodId, staffId, kind (`sale` \| `deposit` \| `refund`), memberId?, bookingId?, tabId?, refundOfSaleId?, lines[], memberDiscountPence, depositAppliedPence, totalPence, tenders[], changePence |
| **SaleLine** | productId, nameAtSale, qty, unitPricePence, vatRate, dealDiscountPence, memberDiscountPence, finalPence, vatPence |
| **Tender** | type (`cash` \| `card`), amountPence |
| **StockMovement** | productId, qty (+/−), reason (`sale` \| `refund` \| `goodsIn` \| `adjustment` \| `waste`), saleId?, staffId, note |
| **Period** | openedAt, openedBy, floatPence, closedAt?, closedBy?, declaredCashPence?, zNumber? |
| **AuditEvent** | type (`void` \| `noSale` \| `refund` \| `priceChange` \| `override` \| `stockAdjust` \| `zClose` \| `backupExport` \| `backupImport`), staffId, approvedById?, detail |
| **Settings** | clubName, receiptFooter, autoLockMinutes, memberDiscountPercent (default 15), lastBackupAt, deviceId, devicePrefix, receiptCounter |

- Receipt numbers are sequential per device: `{devicePrefix}-000001`.
- Sale lines copy the product name, price and VAT rate at the time of sale, so later price edits never change past receipts.
- A booking's unused deposit balance = sum of its deposit sales − sum of deposits applied to sales against it.

---

## 5. Permissions

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

- When a user attempts an action above their level, a dialog asks for a supervisor or manager PIN. A PIN of sufficient level approves **that one action only**, and an `override` audit event records both people.
- The check lives in `rules/permissions.ts` as a pure function: `can(role, action) → boolean`.

---

## 6. Screens and flows

### 6.1 First run
If no staff exist, a setup screen creates the first manager (name + PIN), sets the club name and offers to load the sample data.

### 6.2 Login and auto-lock
- PIN entry on a numeric keypad.
- The till locks after `autoLockMinutes` without a tap (manager-configurable; default 5).
- The current basket is kept as a draft through a lock.

### 6.3 Till
- Category tabs across the top; product button grid below.
- Basket panel on the right (landscape) or a bottom sheet (portrait): line items, deal lines, member line, running total.
- A member badge shows when a member is attached.
- Action buttons: **Member**, **Tab**, **Booking**, **Void** (supervisor+), **No sale** (supervisor+), **Pay**.
- If no trading period is open, selling is disabled and a manager is prompted to open one with a float.

### 6.4 Pay
- Shows the amount due, quick cash buttons (£5, £10, £20, £50, Exact), a custom-amount keypad and **Card**.
- Split payment: each tender reduces the balance; the sale completes when the balance reaches £0.
- Only cash can create change. A card tender cannot exceed the remaining balance.
- On completion the sale is saved, stock movements are written and the receipt opens (6.10).

### 6.5 Members
- Search by name or member number; results show number and name.
- Attaching a member applies the discount in the basket immediately.
- Managers can add, edit and deactivate members.

### 6.6 Tabs
- **Open tab:** choose Name or Table, enter the label, and the current basket moves onto the tab.
- **Tabs screen:** every open tab with its label, total and time open.
- Reopening a tab loads its lines into the basket to add more. Settling it goes to Pay.
- A member attached to a tab stays attached when it is settled.

### 6.7 Bookings and deposits
- **Create booking:** type, name, date, optional notes.
- **Take deposit:** a sale of `kind: deposit` against the booking, paid by cash or card, with its own receipt. Deposits are never member-discounted and don't count as product sales.
- **Final bill:** attaching an open booking to a basket adds a "Deposit taken" minus line for the booking's unused deposit balance.
- If the deposit is bigger than the bill, the bill goes to £0 and the remainder stays on the booking.
- The booking can be marked settled once its deposit balance is used.

### 6.8 Refunds (manager)
- Find the original sale by receipt number.
- Choose lines and quantities to refund, up to what hasn't already been refunded.
- Choose the refund tender (cash or card).
- Per line, choose "return to stock" (default) or "waste".
- This creates a `refund` sale that references the original.

### 6.9 Back office (manager)
Screens for products and categories, deals, members, staff, bookings, stock, settings and backup.
- **Stock:** goods in (product, quantity), adjustment (product, +/−, reason), and a low-stock list of items at or below `lowStockLevel`, including negative stock.

### 6.10 Receipts (simulated printing)
- Completing a sale, deposit, refund, X read or Z close opens a new browser tab with the document laid out at 80 mm width in a monospace till-roll style.
- A receipt shows: club name, date and time, receipt number, staff member, items, deal lines, member discount (with member number), deposit applied, total, tenders, change, a VAT summary by rate and the footer.
- If a popup blocker stops the tab, the same receipt shows in an on-screen panel with a **Reprint** button.

### 6.11 Reports
- **X read (supervisor+):** figures for the current period so far. It does not close the period.
- **Z close (manager):**
  1. warns if tabs are open (they carry over to the next period)
  2. asks for the counted cash
  3. shows expected cash, declared cash and the variance
  4. closes the period, assigns the next Z number and "prints" the Z report
- **Product sales (manager):** date range; quantity and takings per product and per category.
- **VAT report (manager):** date range; net, VAT and gross per rate.

**X and Z report contents:** gross sales, deal discounts, member discounts, refunds, net takings, cash and card totals, deposits taken, deposits applied, no-sale count, void count, VAT by rate, float, expected cash, and (Z only) declared cash and variance.

---

## 7. Pricing rules (precise)

All pricing is computed by pure functions in `src/rules/` and recalculated from scratch whenever the basket changes.

1. **Line gross** = qty × unitPricePence.
2. **Deals**
   - Expand the basket into individual units.
   - For each active deal, collect the qualifying units not already used by another deal.
   - `nForPrice`: sort qualifying units by price, highest first, and form as many complete groups of `n` as possible. Each group's saving = sum of its unit prices − `pricePence`. If that saving is ≤ 0, the deal is not applied to that group.
   - `nForM`: sort qualifying units by price, highest first, and form as many complete groups of `n` as possible. In each group the `n − m` cheapest units are free.
   - When a unit qualifies for more than one deal, evaluate the possible assignments and keep the one with the larger total saving. Each unit counts towards one deal only.
   - Each group's saving is spread across its units in proportion to their price, rounded to the penny, with any rounding remainder on the highest-priced unit so the group total is exact.
3. **Member discount**
   - Base = sum of (line gross − line deal discount) for member-eligible lines.
   - Discount = round-half-up(base × memberDiscountPercent ÷ 100).
   - Spread across eligible lines in proportion to their post-deal amount, with the rounding remainder on the largest line, so the lines sum exactly to the discount.
4. **Deposit applied** = min(booking's unused deposit balance, basket total after steps 1–3). It is a sale-level adjustment and is not spread across lines.
5. **VAT per line**
   - Line final = line gross − deal discount − member discount.
   - Line VAT = round-half-up(line final × vatRate ÷ (100 + vatRate)).
   - Line net = line final − line VAT.
   - Reports sum line figures, so reports always equal the sum of receipts.
6. **Total to pay** = sum of line finals − deposit applied.

**Cash-up formula:** expected cash = float + cash tendered − change given − cash refunded.

Deposit sales count in cash and card totals like any other payment. Deposits applied are reported separately and don't change the cash drawer.

---

## 8. Error handling

| Situation | Behaviour |
|---|---|
| A save fails | Sale is not marked complete; a clear error shows; the basket is kept; nothing partial is written (all writes for one sale happen in one Dexie transaction) |
| Page refreshed or closed mid-sale | Basket saved as a draft after every change; restored at next login |
| Browser could clear local data | Call `navigator.storage.persist()` on first run; show a warning banner if it's refused |
| No backup for 7 days | Reminder banner for managers |
| Backup import | Validates file structure and version first; replaces all data only after a typed confirmation; writes an audit event |
| Z close with open tabs | Warning; tabs carry over and count in the period in which they're settled |
| Stock at or below zero | Selling is never blocked; the item goes negative and shows on the low-stock list |
| Receipt tab blocked by the browser | Receipt shown in an on-screen panel with a Reprint button |
| Refund quantity above what's left to refund | Prevented in the refund screen |
| Card tender above the balance | Prevented |
| No open period | Selling disabled until a manager opens one |

---

## 9. Sample data

Loaded on first run if chosen. All names and prices are made up.

- **Categories:** Draught, Bottles & Cans, Spirits, Wine, Soft Drinks, Snacks, Events
- **Products:** about 40 across those categories, each with a realistic price, VAT rate and starting stock. Most are 20%; at least one is 0% so the VAT report shows two rates.
- **Deals:** one `nForPrice` deal and one `nForM` deal
- **Members:** 20 fictional members
- **Staff:** the manager created at setup, plus one sample staff and one sample supervisor account
- **Bookings:** one wedding and one society day, with no deposits yet

---

## 10. Testing

### 10.1 Rules (Vitest, written test-first)
Worked examples with exact expected pence for:
- a single item; multiple quantities
- `nForPrice` with equal prices, mixed prices, a leftover unit, and a deal that would raise the price (not applied)
- `nForM` with mixed prices
- an item eligible for two deals (the bigger saving wins)
- member discount with and without deals, including half-penny rounding and remainder spreading
- a member-ineligible item in a member basket
- VAT at 20% and 0%, and a mixed basket, with line totals matching the basket total
- split cash + card; change from cash only; card above balance rejected
- deposit smaller than, equal to and larger than the bill
- a partial refund
- Z expected cash with float, change, cash refunds and deposits
- the permission matrix in section 5

### 10.2 Data layer (Vitest + fake-indexeddb)
A contract suite in `tests/data/` that every adapter must pass:
- create and read each entity
- sales and stock movements are append-only
- stock on hand is derived from movements
- one outbox entry per write
- one transaction per sale (a forced failure leaves nothing behind)
- a backup round-trip gives identical data

### 10.3 End-to-end (Playwright), at tablet landscape and phone portrait
1. First run → create manager → load sample data → open period
2. Sale with a deal and a member, split payment, receipt tab opens with the correct totals
3. A tab by name and a tab by table number → add items twice → settle
4. Booking → take deposit → final bill with deposit applied → balance paid
5. Staff user tries to void → supervisor PIN override → audit event exists
6. Manager refund with return-to-stock → stock level restored
7. X read → Z close with a declared-cash variance → Z report figures match the sales made
8. Refresh mid-basket → basket restored after login

### 10.4 Definition of done for each stage
- All tests pass
- Type-check and lint are clean
- Reviewer station verdict is pass
- Screens checked at both sizes

---

## 11. Future: Supabase offline-first (not in v1)

Recorded here so v1 decisions stay compatible with it.

- Add a `SupabaseAdapter` implementing the same repository interfaces. It keeps reads and writes local and pushes outbox entries to Supabase when online.
- Append-only sales and stock movements need no conflict handling beyond de-duplication by `id`.
- Editable records (products, members, deals, settings) resolve conflicts last-write-wins on `updatedAt`.
- Receipt numbers are already unique per device through the device prefix.
- The adapter must pass the repository contract suite (10.2) before it replaces the LocalAdapter.
