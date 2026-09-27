# Club EPOS — UI plan

**Status:** binding for the UI screen packages. Read `docs/design-spec.md`, `docs/decisions.md` (D-nnn) and `docs/architecture.md` §7 first; this file is the API reference for what is already built and the rules for what you build.

The foundation is done and tested: routing and guards, the app shell, auto-lock, the PIN override dialog, the receipt popup + fallback, banners, every Zustand store, every shared component, the Setup and Login screens, and the e2e helpers. Every other screen exists as a **placeholder** at the path and export name listed in §8; your package replaces those files.

Contents: §1 rules · §2 routes, guards and screen titles · §3 components · §4 stores · §5 app helpers · §6 styling · §7 flows per package · §8 file ownership · §9 e2e helpers and selectors · §10 known limits.

---

## 1. Rules for screen code

- **Call services, never re-implement them.** Pricing, VAT, change, report figures, permissions and validation live in `src/services/*` and `src/rules/*`. Screens show what services return (e.g. `BasketView.priced.totalPence`, `TabSummary.totalPence`). If a figure looks wrong, report it; do not patch it in React.
- **Imports allowed in screens/components/stores:** `src/services/*`, pure display helpers from `src/rules/*` (`formatPence`, `negate`, `can`, `formatDateTime`, `formatLocalDate`, `tabDisplayLabel`, validators, label maps), types from `src/data/types.ts`, `AppError`/`isAppError` from `src/data/errors.ts`, and `src/app`, `src/components`, `src/store`. **Never** `dexie`, `src/data/local` or a repository directly (`ctx.repos.*`); only `src/app/bootstrap.ts` constructs the adapter.
- **The ServiceContext:** `useCtx()` in components, `getCtx()` elsewhere (both from `src/store`). Screens only render after boot, so it is never null there.
- **Permissions (D-070):** navigation and lists are never gated. Gate the button that writes data or produces a document with `requirePermission(action)` and pass the result to exactly one service call (§5.1). Never hide Void / No sale for staff.
- **Errors (D-117):** services throw `AppError { code, message, fieldErrors? }`. Show `errorMessage(e)`; spread `fieldErrorsOf(e)[field]` into form fields; branch on `code` (see D-124 for which codes each flow can raise).
- **Documents (D-109):** after a service returns `document` (receipt, X read, Z report), call `openDocument(document)` straight away in the same async chain as the click. Never `dangerouslySetInnerHTML` (D-110).
- **British English**, sentence-case labels, money only through `MoneyText` / `formatPence` (`£1,234.56`, `-£1.73`).
- **TypeScript strict** (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`: `import type` for types; `erasableSyntaxOnly`: no enums, no parameter properties, no namespaces).
- **react-hooks v7 lint rules are errors**: no synchronous `setState` in an effect body (use `useLoad`, or set state in event handlers / promise callbacks), no reading `ref.current` during render, no `Date.now()` in render (use `nowMs()` from `src/app/clock` inside handlers/effects). With Zustand 5, select primitives or single objects (`useStore((s) => s.basket)`); a selector that builds a new object/array each call loops forever — use `useShallow` from `zustand/react/shallow` if you must.
- **Stay in your package.** Shared files (`src/app`, `src/components`, `src/store`) may take small additive, backward-compatible edits only when unavoidable; re-read the file first.

---

## 2. Routes, guards and screen titles

`src/app/App.tsx` (hash router). Guards (`src/app/guards.tsx`): no staff → `#/setup`; no session → `#/login`; logged in on `#/login`/`#/setup`/`#/` → `#/pay` if a Pay session exists, else `#/till`. Unknown paths go home. Selling-path screens are in the main chunk; the others load lazily (their own chunks, precached for offline use), so keep each screen's **named export** exactly as below.

| Route | File (export) | `<h1>` (Screen `title`, stable for tests) |
|---|---|---|
| `#/setup` | `src/screens/setup/SetupScreen.tsx` (`SetupScreen`) — done | `Set up this till` |
| `#/login` | `src/screens/login/LoginScreen.tsx` (`LoginScreen`) — done | the club name |
| `#/till` | `src/screens/till/TillScreen.tsx` (`TillScreen`) | `Till` (may be `hideTitle`) |
| `#/pay` | `src/screens/pay/PayScreen.tsx` (`PayScreen`) | `Pay` |
| `#/tabs` | `src/screens/tabs/TabsScreen.tsx` (`TabsScreen`) | `Tabs` |
| `#/bookings` | `src/screens/bookings/BookingsScreen.tsx` (`BookingsScreen`) | `Bookings` |
| `#/bookings/:id` | `src/screens/bookings/BookingDetailScreen.tsx` (`BookingDetailScreen`) | the booking name |
| `#/members` | `src/screens/members/MembersScreen.tsx` (`MembersScreen`) | `Members` |
| `#/refunds` | `src/screens/refunds/RefundScreen.tsx` (`RefundScreen`) | `Refunds` |
| `#/period` | `src/screens/period/PeriodScreen.tsx` (`PeriodScreen`) | `Period` |
| `#/reports` | redirects to `#/reports/product-sales` | — |
| `#/reports/product-sales` | `src/screens/reports/ProductSalesReportScreen.tsx` (`ProductSalesReportScreen`) | `Product sales report` |
| `#/reports/vat` | `src/screens/reports/VatReportScreen.tsx` (`VatReportScreen`) | `VAT report` |
| `#/backoffice` | `src/screens/backoffice/BackOfficeMenu.tsx` (`BackOfficeMenu`) | `Back office` |
| `#/backoffice/products` · `categories` · `deals` · `staff` · `stock` · `settings` · `backup` | `src/screens/backoffice/{Products,Categories,Deals,Staff,Stock,Settings,Backup}Screen.tsx` (same export names) | `Products`, `Categories`, `Deals`, `Staff`, `Stock`, `Settings`, `Backup` |
| `#/dev/components` | `src/app/dev/ComponentGallery.tsx` | dev server only (not in builds) |

`tests/e2e/setup-login.spec.ts` checks the menu reaches each top-level screen and finds its `<h1>` by the title above, so keep those titles. Adding sub-routes: add a line to `App.tsx` (additive edit), or render sub-views inside your screen.

**The shell** (`src/app/AppShell.tsx`) renders the header — club name (link to the till), period status (`period-status`: `Period open` / `No period open`), staff name (`current-staff`) and role, **Menu** and **Lock** — then the manager banners, then your screen inside `<main id="main">`. The header owns the only `Menu` and `Lock` buttons: **screens must not add buttons with those names.**

---

## 3. Shared components (`src/components`, barrel `src/components/index.ts`)

All are accessible (real `<button>`s with names, labelled groups/dialogs), touch-sized (≥ 48 px) and work at 390 px and 1280 px. Props marked `?` are optional.

### Button, ButtonLink, buttonClassName
- `Button` — `variant?: 'primary' | 'secondary' (default) | 'danger' | 'dangerOutline' | 'ghost' | 'onBrand'`, `size?: 'sm' | 'md' | 'lg' | 'xl'` (40 / 48 / 56 / 72 px tall; `sm` keeps a 48 px hit area), `block?`, `busy?` (spinner, `aria-busy`, `aria-disabled`: clicks and form submits are ignored, but it stays focusable so a focused button keeps focus, D-134), plus every `<button>` attribute. `type` defaults to `'button'`. `aria-disabled="true"` alone also makes it ignore clicks while staying focusable.
- `ButtonLink` — a react-router `Link` styled as a button (`to`, `variant?`, `size?`, `block?`).
- `buttonClassName({ variant, size, block, className })` — the same classes for anything else.

### MoneyText
`pence: number`, `asDeduction?` (a stored positive shown as a subtraction: `formatPence(negate(pence))`, tinted), `size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'`, `strong?`, `tone?: 'default' | 'muted'`, `testId?`, `id?`, `className?`. Always tabular numerals.

### NumericKeypad (money, D-006)
`valuePence`, `onChange(pence)`, `label` (group name + display label, e.g. `Float`, `Amount`, `Counted cash`), `disabled?`, `hideDisplay?` (the screen shows the amount elsewhere; the delete key moves into the grid and `Clear` becomes a wide key), `captureKeyboard?` (physical 0–9, Backspace, Delete=clear; ignored in text fields and behind a modal; default false), `onEnter?` (Enter while the keypad group itself has focus, e.g. the dialog's primary action; Enter on a focused key presses that key; needs `captureKeyboard`), `size?: 'md' | 'lg'`, `displayTestId?`. Keys: `0`–`9`, `00`, `Delete last digit`, `Clear` (visible `C`). Uses `pressMoneyKey` (7-digit cap). Controlled: keep the value in state or `usePayStore.keypadPence`. The group is focusable (tabIndex −1) and is a Modal's initial focus (`data-autofocus`), never `Delete last digit` (D-134).

### PinKeypad (D-073, D-076)
`onSubmit(pin)` (4–6 digits, on Enter; the entry clears immediately), `label` (visible prompt + group name), `disabled?` (lockout), `busy?` (Enter shows `Checking…`), `error?` (role=alert, e.g. `PIN not recognised`), `status?` (e.g. the lockout countdown; `role="timer"`, not a live region), `announcement?` (read once by a polite live region: `useLockoutAnnouncement(remaining)`, D-135), `captureKeyboard?` (default true), `submitLabel?` (`Enter`), `tone?: 'light' | 'dark'`, `testId?`. Keys: `1`–`9`, `0`, `Clear`, `Delete last digit`, `Enter`. Digits are never shown. The group is focusable and is a Modal's initial focus; taps don't move focus onto keys; Enter on a focused key activates it, Enter elsewhere submits (D-132). For new PINs in forms (staff), use `TextField type="password" inputMode="numeric"` twice (D-073), as Setup does.

### Modal
`open`, `onClose`, `title` (the accessible name), `hideTitle?`, `description?` (aria-describedby), `describedBy?` (id of a body element that also describes the dialog; ConfirmDialog uses it for its message), `children`, `footer?` (action buttons), `size?: 'sm' | 'md' | 'lg' | 'full'`, `placement?: 'center' | 'bottom' | 'right'`, `dismissible?` (Escape + backdrop; default true — pass `false` while saving), `showCloseButton?` (header `×` named `Close`; default **false**: give the footer a Cancel instead so names stay unique), `initialFocus?` (ref) or put `data-autofocus` on an element, `testId?`. role=dialog, aria-modal, focus moved in, trapped and restored (to the nearest `tabindex="-1"` container or `<main>` when the opener is now disabled or gone, D-135); the rest of the app (`#root`) and lower dialogs become `inert`; body scroll locked. Nested modals stack correctly (the override dialog opens on top of yours).

### ConfirmDialog
`open`, `title`, `message?`, `confirmLabel?` (`Confirm`), `cancelLabel?` (`Cancel`), `tone?: 'default' | 'danger'`, `busy?`, `onConfirm`, `onCancel`, `children?` (e.g. an error Banner), `testId?`. For a one-off question without local state use `await confirmDialog({ title, message, confirmLabel, cancelLabel, tone })` from `src/store` (resolves `false` on cancel or lock).

### Toast / Toaster
Show with `toast(message, { tone?: 'info' | 'success' | 'warning' | 'danger', durationMs? })` from `src/store`. The root renders them (top centre, `pointer-events: none`, so they never block a tap; `data-testid="toast"`; one confirmation at a time, the newest replacing the last, for 2.5 s; errors up to two for 6 s (D-140); cleared on lock). Use for confirmations such as `Drawer opened`; use a `Banner` for anything the user must read or act on.

### Banner
`tone?: 'info' | 'success' | 'warning' | 'danger'`, `title?` (bold lead-in), `children`, `action?` (buttons/links), `onDismiss?` + `dismissLabel?` (default `Dismiss`), `role?: 'alert' | 'status' | 'none'` (default alert for danger), `testId?`. In flow: it takes space and never overlays buttons.

### BottomSheet (portrait basket, < 900 px)
`title` (expanded dialog title, e.g. `Basket`), `open`, `onOpenChange(open)`, `summary` (bar content inside the toggle, e.g. item count + total), `toggleLabel?` (default `View basket`; the toggle's name is this label followed by the visible summary, e.g. `View basket 3 items £12.90`, so match it with `/^View basket /`), `barActions?` (e.g. the Pay button), `children` (expanded content, e.g. `<BasketPanel hideHeading … />`), `footer?`, `testId?`. Renders an in-flow spacer plus a bar fixed to the bottom; the expanded sheet is a bottom-placed Modal with a `Close` button.

### ProductButton
`product: Pick<Product, 'id' | 'name' | 'pricePence' | 'buttonColour'>`, `onPress(productId)`, `disabled?`, `qtyInBasket?` (badge). Background = `buttonColour`, text colour chosen for WCAG AA (`readableTextColour`). **Accessible name = exactly the product name** (price is the description): `getByRole('button', { name: 'Club Bitter', exact: true })`. ≥ 88 px tall (80 px under 600 px wide).

### CategoryTabs
`categories: Pick<Category, 'id' | 'name' | 'colour'>[]`, `selectedId`, `onSelect(id)`, `panelId` (id of your `role="tabpanel"` element), `label?` (`Categories`). WAI-ARIA tablist with arrow/Home/End keys; scrolls sideways inside itself. Give the panel `aria-labelledby={categoryTabId(panelId, selectedId)}`.

### BasketPanel and BasketLineRow
`BasketPanel` props: `view: BasketView | null` and `basket: BasketState` (both from `useBasketStore`), `memberDiscountPercent?` (`useAppStore(s => s.settings?.memberDiscountPercent)`), `selectedProductId?`, `onSelectLine?(productId)` (lines become toggle buttons, `aria-pressed`), `lineTrailing?(line)` (extra per-line controls), `onRemoveMember?` / `onRemoveBooking?` (show `Remove member` / `Remove booking`), `pricing?` (aria-busy), `stale?` (the last pricing failed: the old lines and total are not shown, D-138), `actions?` (under the total, e.g. Pay), `heading?` (`Basket`), `hideHeading?`, `disabled?`. Shows the tab badge (`tab-badge`), member badge (`member-badge`: `1001 — Alice Archer`), booking badge (`booking-badge`), lines (`{qty} × name`, then `@ £unit` and the gross on the line under the name, D-138), deal lines (`deal-line`, `{name} x{n}` −saving), member discount (`member-discount-line`, whenever a member is attached), deposit (`deposit-line`, `Deposit taken`, only when > 0) and the total (`basket-total`). Display only — no pricing.
`BasketLineRow` (used by the panel): `line: PricedLine`, `selected?`, `onSelect?`, `trailing?`, `disabled?`.

### ReceiptFallbackPanel
Mounted once by the root; you never render it. `openDocument()` shows it when the popup is blocked (dialog `data-testid="receipt-fallback"`, sandboxed `srcdoc` iframe, `Reprint`, `Close`). Only Close and Reprint close it (not Escape or the backdrop); a lock hides it until the next login (D-135).

### SearchList
`label` (search box label), `query`, `onQueryChange`, `results`, `getKey`, `renderItem` (button content), `getItemLabel?` (button name), `onSelect(item)`, `placeholder?`, `hint?`, `emptyMessage?` (`No matches`), `idleMessage?`, `loading?`, `autoFocus?`, `resultsLabel?` (`Results`), `isSelected?` (aria-pressed), `disabled?`. The caller runs the search (debounce with `useDebouncedValue`).

### FormField, TextField, TextAreaField, SelectField, CheckboxField
`FormField({ label, hint?, error?, required?, hideLabel?, announceError?, children: (control) => ReactNode })` wires `id`, `aria-describedby`, `aria-invalid`; `announceError` gives the error `role="alert"` (for a field whose error arrives while it already has focus, D-134). Convenience fields take `label`, `value`, `onChange(value)` (string, or boolean for checkboxes), `hint?`, `error?` plus native attributes: `TextField` (any input type, e.g. `password`, `date`, `search`), `TextAreaField` (`rows?`), `SelectField` (`options: { value, label, disabled? }[]`, `placeholder?` adds a `''` option), `CheckboxField` (`checked`). Labels are plain text (no `*`), so `getByLabel('PIN', { exact: true })` works.

### DataTable
`caption` (accessible name), `hideCaption?`, `columns: { key, header, render(row), align?, numeric?, rowHeader?, width? }[]`, `rows`, `getRowKey`, `emptyMessage?`, `footer?` (totals row keyed by column key), `rowClassName?`, `testId?`, `dense?`, `className?` (on the scrolling region). Scrolls sideways inside its own focusable region, with an edge shadow on the side that has more to scroll to.

### Screen
`title` (the page `<h1>` and `document.title`), `hideTitle?`, `description?`, `actions?` (title-row buttons), `children`, `width?: 'narrow' | 'default' | 'full'` (640 px forms / 1120 px / edge to edge for the till). One per screen. When it mounts with focus lost (on `<body>` or `<main>`, e.g. after the button that changed the route went with the old screen), its `<h1>` (`tabindex="-1"`) takes focus (D-136).

### Hooks and helpers
`useIsWide()` (≥ 900 px: side basket panel), `useMediaQuery(query)`, `useDebouncedValue(value, ms?)`, `readableTextColour(hex)`, `contrastRatio(a, b)`, `safeColour(hex)`, `categoryTabId(panelId, id)`, `keepFocusWhenRemoved(control)` (call in a click handler that may remove its own button: focus then goes to the nearest `tabindex="-1"` container or `<main>`, not `<body>`, D-135; Banner's dismiss and BasketPanel's remove buttons already do; a closing Modal does it for the opener it restores focus to, in case the screen's reload after a save removes it, D-139).

---

## 4. Stores (`src/store`, barrel `src/store/index.ts`)

Screen and basket state only; persistent data lives in the data layer. Read state with selectors (`useBasketStore((s) => s.view)`), call actions via `useXStore.getState().action()` in handlers.

### appStore
State: `status: 'booting' | 'ready' | 'failed'`, `ctx`, `bootState: 'setup' | 'login' | null`, `bootError`, `settings: Settings | null`, `openPeriod: Period | null`, `storageStatus`.
Actions: `boot(createContext, failureMessage)` (App only), `refreshSettings()`, `refreshPeriod()`, `refreshAll()`, `refreshStorageStatus()`.
Helpers: `getCtx()`, `useCtx()`, `useHasOpenPeriod()`.
**Refresh after you change them:** `refreshPeriod()` after opening a period or a Z close; `refreshSettings()` after saving settings (header club name, auto-lock minutes, discount %).

### sessionStore
State: `session: Session | null` (`{ staffId, name, role }`), `pinAttempts` (shared login/override lockout, D-076), `lastActivityMs`, `banners: { backupDue, storageWarning }`, `dismissed`.
Actions: `start(session, nowMs)`, `end()`, `touch(nowMs)`, `pinFailed(nowMs)`, `pinSucceeded()`, `lockoutRemaining(nowMs)`, `setBanners(partial)`, `dismissBanner(key)`. Use `signIn` / `lock` (§5.4) rather than `start` / `end` directly. Hook: `useSession()`.

### basketStore (D-008, D-033, D-068, D-085, D-095, D-096, D-137)
State: `basket: BasketState` (`{ lines: {productId, qty}[], memberId?, bookingId?, tabId? }`), `view: BasketView | null` (exactly `services/till.viewBasket`; while a sale payment has tenders its `priced` is the Pay session's frozen pricing, D-137), `pricing`, `error` (pricing only), `draftError` (the last draft save failed; cleared only by a successful save, D-137).
Actions (every change saves the draft and re-prices):
- `addProduct(productId): Promise<boolean>` — false (with a toast) when no period is open (`No trading period open`), a sale payment has tenders (`Finish or cancel the payment first`) or the line is at 999 (`Maximum quantity is 999`).
- `voidLine(auth, productId, qty)` — `auth` from `requirePermission('voidLine')`; the basket changes only after the void audit event commits; throws the service's `AppError`.
- `attachMember(memberId)` / `detachMember()`, `attachBooking(bookingId)` / `detachBooking()` — attaching needs an open period.
- `load(basket)` — put the result of a tab service (`loadTab`, `openNewTab`, `addBasketToTab`, `parkTab`) into the store.
- `reset()` — after a sale commit (payStore does it for you).
- `restoreDraft(): Promise<number>` — used by `signIn`.
- `retryDraftSave(): Promise<boolean>` — saves the current basket as the draft again (the till's Try again on "The basket could not be saved.").
- `refresh()` — re-price with no change (call when the Till mounts, after price or settings edits).
Guard: a sale Pay session with **no** tenders is dropped when the basket changes (its frozen pricing is stale, D-011); with tenders the basket is frozen (D-033), and so it is while Pay is opening (D-130). Changes run one at a time: each reads the basket when its turn comes (`runBasketExclusive`, D-130). Helpers: `basketUnitCount(basket)`, messages `NO_PERIOD_MESSAGE`, `PAYMENT_IN_PROGRESS_MESSAGE`, `MAX_QTY_MESSAGE`.

### payStore (D-011, D-029..D-034)
State: `session: PaySession | null` (`SalePaySession` with `basket`, frozen `priced`, the `memberDiscountPercent` it used (D-135), `tender`; or `DepositPaySession` with `booking`, `amountPence`, `tender`), `opening` (openSale running; the basket is frozen, D-130), `keypadPence`, `committing`, `error`.
Actions: `openSale()` (current basket → `openSalePayment`; throws `AppError`), `openDeposit(bookingId, amountPence)`, `pressKey(key)`, `setKeypad(pence)`, `tender({ type: 'cash' | 'card', amountPence: number | null })` → `TakeTenderResult | null` (rejection message in `error`; keypad clears on success), `complete(auth)` → `CompletedSale | null` (success clears the session and, for a sale, resets the basket; failure keeps the tenders and sets `error` to `Sale not saved: {message}`, or `Deposit not saved: …`, D-131), `clear()` (Back to basket / Cancel payment), `clearError()`. Helpers: `isBasketFrozen(session)`; `dropUntenderedPayment(which?)` drops the session only when no tender is taken (and it is not saving), optionally only when `which(session)` — used after a Z close and after a booking closes (D-134).
The Pay session survives a lock; after login the guard sends the user to `#/pay`. It is lost on refresh (D-033). Leaving Pay by navigation (Menu, Back) drops a sale session with no tenders (D-135).

### uiStore
State: `toasts`, `receiptFallback`, `overrideRequest`, `confirmRequest`, `lockCount` (increments on every lock).
Actions: `toast`, `dismissToast`, `clearToasts`, `showReceiptFallback`, `closeReceiptFallback`, `requestOverride(action)` (use `requirePermission`), `settleOverride`, `confirm(options)` (use `confirmDialog`), `settleConfirm`, `cancelDialogs()` (lock; keeps `receiptFallback`, D-135). Shorthands: `toast(message, options?)`, `confirmDialog(options)`.

---

## 5. App helpers (`src/app`, barrel `src/app/index.ts`)

### 5.1 requirePermission(action): Promise<Authorisation | null>
The one gate (D-070, D-071). If `can(session.role, action)`: resolves `{ action, staffId }` at once (no dialog, no override event). Otherwise opens the **override dialog** (title `Supervisor or manager PIN` or `Manager PIN`, `data-testid="override-dialog"`, message `PIN not accepted`, shared 5-try / 30 s lockout) and resolves `{ action, staffId, approvedById }` for that ONE action, or `null` on Cancel / lock / no session. Pass the result to exactly one service call; the service writes the `override` audit event with the action (D-072).
```ts
const auth = await requirePermission('noSale');
if (auth === null) return;
await recordNoSale(getCtx(), auth);
toast('Drawer opened');
```
Actions: `sell`, `tabs`, `attachMember`, `bookings` (always direct), `voidLine`, `noSale`, `xRead` (supervisor), `refund`, `openClosePeriod`, `editCatalogue`, `stockControl`, `manageMembersStaffSettings`, `salesReports`, `backup` (manager).

### 5.2 openDocument(html): boolean
Blob URL + `window.open(url, '_blank')`, `opener = null`, URL revoked after 60 s; if blocked, the fallback panel (D-109). Returns true when the tab opened. Also `tryOpenDocument`, `reprintFallback`, `documentTitle(html)`.

### 5.3 useAutoLock()
Mounted once by the root. `pointerdown`/`keydown` (capture) record activity; a 1 s interval locks after `settings.autoLockMinutes` (changes apply immediately). Lock keeps the basket, draft and Pay session; cancels the override/confirm dialogs; hides the receipt panel until the next login (its document is kept, D-135); clears toasts; the guard then shows the login screen, which unmounts your screen (unsaved form input is discarded, D-078). Screens need do nothing.

### 5.4 Session flows (`src/app/auth.ts`)
- `signIn(session)` — restores the draft if the basket is empty (toast `N item(s) removed from the saved basket` as `1 item removed…` / `2 items removed…`), computes manager banners, starts the session; returns `'/pay' | '/till'` (the guards navigate).
- `lock()` — the Lock button and auto-lock.
- `refreshBanners()` — re-evaluate the backup/storage banners (call after a backup export).
- `afterBackupImport()` — after `importBackup`: ends the session, clears basket and Pay, reloads settings and period; the login screen shows (D-090).
- `homeRoute()`.

### 5.5 Data loading and errors
- `useLoad(load: (ctx) => Promise<T>, deps)` → `{ data, error, loading, reload }` (deps compared as JSON). Use it for every list/detail load; call `reload()` after a save.
- `errorMessage(e)`, `fieldErrorsOf(e)`, `errorCode(e)`.
- `downloadTextFile(fileName, text, type?)` for the backup export (D-091).

### 5.6 Periods
- `<NoPeriodPrompt />` — `No trading period open` + `Open period` (`data-testid="no-period"`). The Till shows it while `useHasOpenPeriod()` is false (**keep it**: the e2e `openPeriod` helper uses it). The Period screen may use it too.
- `<OpenPeriodDialog open onClose onOpened? />` — float keypad (`Float`, `data-testid="float-amount"`) → `Open period` → `requirePermission('openClosePeriod')` → `openPeriod` → `refreshPeriod()` → toast. Dialog name `Open period`, `data-testid="open-period-dialog"`.

### 5.7 Other
`serviceWorker.ts` (`registerServiceWorker()`, called once by `main.tsx`; reloads onto a new build once no payment is in flight and the receipt fallback panel is closed, `updateReload.ts`, D-133, D-134), `clock.ts` (`nowMs`, `now`, `nowIso` — the only UI clock, D-101), `useLockoutRemaining()` + `lockoutMessage(ms)`, `ROLE_LABELS`, `NAV_GROUPS`, `Banners` (rendered by the shell: `No backup in the last 7 days` + `Back up now` → `#/backoffice/backup`, and `STORAGE_WARNING`; both `testId`s `backup-reminder`, `storage-warning`), `OverrideDialog`, `GlobalUi`, `FullScreenFrame`.

---

## 6. Styling conventions

- **Tokens** live in `src/app/theme.css` (`:root` custom properties). Use them; never hard-code colours except user data (category/product colours). Key tokens: brand `--color-brand-900` (#14532d chrome), `-800`, `-700`, `-50`; surfaces `--color-bg` (off-white page), `--color-surface` (cards), `--color-surface-sunken`, `--color-border`, `--color-border-strong`; text `--color-text`, `--color-text-muted` (all AA); status `--color-{danger,warning,info,success}` with `-bg` / `-border`; `--color-money-negative`.
- **Spacing** 4 px scale: `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 24, `-6` 32, `-7` 48, `-8` 64. `--page-gutter` is 16 px (24 px ≥ 900 px). Radii `--radius-sm/--radius/--radius-lg`. Shadows `--shadow-sm/md/lg`.
- **Type**: system font stack only (offline; no web fonts/CDNs). Sizes `--font-size-xs … -3xl`. Money: `MoneyText` (or the global `.money` / `.tabular` class) for tabular numerals.
- **Touch**: every control ≥ 48 × 48 px (`--touch-min`); primary actions 56 px (`--touch-lg`); Pay / Complete sale 72 px (`--touch-xl`, `Button size="xl"`), except the phone basket bar's Pay, which is 56 px so the 72 px bar leaves the products their space (the open sheet's Pay is 72 px, D-139); product buttons ≥ 88 px (`--product-min-height`); list rows ≥ 56 px.
- **Breakpoints**: `≥ 900 px` wide = landscape tablet → the till shows the **side basket panel** (`--basket-panel-width` 380 px); `< 900 px` → **BottomSheet**. `useIsWide()` in code, `@media (min-width: 900px)` in CSS. `< 600 px` = phone tweaks (modal footers share width, header icon buttons). Test at 1280 × 800 and 390 × 844.
- **Layout**: the shell is exactly `100dvh`; the header and banners are fixed height; `<main id="main">` is the scroll container and is scrolled to the top on every route change (D-135). `<main>` is `position: relative` and the shell clips (`overflow: clip`), so absolutely positioned content (`.visually-hidden`) can never make the document itself scroll (D-137). Normal screens use `<Screen>` and scroll inside main. The till uses `<Screen width="full">` and should fill main (`flex: 1; min-height: 0`) with its own inner scroll areas (product grid, basket lines).
- **No horizontal page scroll at 390 px**: long content scrolls inside its own element (DataTable, CategoryTabs). `expectNoHorizontalScroll(page)` checks it.
- **Colour**: category/product colours come from data — always pair with `readableTextColour`. Deductions use `MoneyText asDeduction`.
- **Focus**: `:focus-visible` outline `--focus-ring` (blue on light, amber `#fcd34d` on the green header/login). Never remove outlines.
- **Stacking**: `--z-header` 10, `--z-sheet-bar` 20, `--z-modal` 50, `--z-toast` 70. Use `Modal` for any overlay; don't hand-roll fixed layers.
- **CSS**: one `*.module.css` per component/screen; global classes only `.money`, `.tabular`, `.visually-hidden`, `.skip-link`.
- **Naming for tests**: keep button names unique on a screen (`exact: true` matching). `Menu` and `Lock` are reserved for the header. Dialog titles are their accessible names.

---

## 7. Flows per package (what to wire)

### till (`TillScreen`)
- Layout: `<Screen title="Till" hideTitle width="full">`. Wide: category tabs + product grid | `BasketPanel` (actions: `Pay`). Narrow: tabs + grid, then `BottomSheet` (summary: item count and total with `data-testid="basket-bar-total"`; `barActions`: `Pay`; children: `<BasketPanel hideHeading …/>`). Render only one `BasketPanel` at a time so `basket-total` stays unique.
- Catalogue: `useLoad(loadTillCatalogue, [])`; call `useBasketStore.getState().refresh()` on mount.
- No open period (`!useHasOpenPeriod()`): show `<NoPeriodPrompt />` instead of the product grid; selling disabled (the store also refuses).
- Action buttons with exactly these names: `Member`, `Tab`, `Booking`, `Void`, `No sale`, `Pay` (architecture §7.4). Void: pick a line (`onSelectLine`), `Void` → quantity (1..qty, default all) → `requirePermission('voidLine')` → `voidLine(auth, productId, qty)`. No sale: `requirePermission('noSale')` → `recordNoSale` → toast `Drawer opened`.
- Member: dialog with `SearchList` + `searchMembers` → `attachMember(id)`; remove via the panel's `Remove member`.
- Booking: `listAttachableBookings` → `attachBooking(id)`; remove via `Remove booking`.
- Tab: New tab (Name/Table + label) → `requirePermission('tabs')` → `openNewTab(ctx, auth, basket, labelType, label)` → `load(result.basket)`; Add to tab (`listOpenTabs`) → `addBasketToTab`; in tab mode `Save to tab` → `parkTab`. Show `AppError` messages (D-124).
- Pay: `await usePayStore.getState().openSale()` then `navigate('/pay')`; show errors (`VALIDATION`, `NOT_FOUND`, `BOOKING_NOT_OPEN`, `TAB_NOT_OPEN`). When `isBasketFrozen(paySession)`, show a banner with a link back to Pay.

### pay (`PayScreen`)
- No session → `<Navigate to="/till" replace />`.
- Show amount due (`amount-due`), remaining (`remaining`), the tenders taken, change (`change-due`) and, for deposits, the booking. Buttons: `£5`, `£10`, `£20`, `£50` (`QUICK_CASH_PENCE`, enabled while remaining > 0), `Exact`, `Cash` (keypad amount; disabled at 0), `Card` (keypad amount or the remaining balance), a `NumericKeypad` bound to `keypadPence` (`captureKeyboard`).
- After a tender whose result is complete (or at once via `Complete sale` when the total is 0, D-031): `requirePermission(kind === 'sale' ? 'sell' : 'bookings')` → `complete(auth)` → `openDocument(done.document)` → navigate (`/till` after a sale, `/bookings/:id` after a deposit).
- `Back to basket` (no tenders) → `clear()`; `Cancel payment` (tenders taken) → `confirmDialog` → `clear()`. Failure: show `error` with `Try again` and `Cancel payment` (D-034).
- Double taps (D-134): the tender panel ignores taps for `TENDER_REST_MS` (400 ms) after Pay opens and after every tender attempt; nothing above the tender keys changes height (a refusal shows under them via `TenderPanel`'s `notice`; below 900 px `PayTotals compact` puts every tender in one fixed-height `Taken` row). With no open period the tender keys and Complete sale are disabled with a `pay-no-period` banner.

### tabs-bookings-members
- Tabs: `useLoad((ctx) => listOpenTabs(ctx, basket), [basket.tabId])`; `Load` → `requirePermission('tabs')` → `loadTab` → `load(basket)` → `/till`; `Settle` → load then `openSale()` → `/pay`. Labels via `TabSummary.displayLabel`, time open via `timeOpen`, `On till` when `onTill`.
- Bookings: `listBookings` / `getBookingSummary`; create/edit (`saveBooking`), `Take deposit` (money keypad) → `openDeposit(bookingId, amount)` → `/pay`; `Mark settled` / `Cancel booking` enabled from `BookingSummary.canSettle/canCancel`, each gated by `requirePermission('bookings')` + confirm.
- Members: `searchMembers` for everyone; managers add/edit/deactivate (`saveMember`, `setMemberActive`) with `requirePermission('manageMembersStaffSettings')` on Save.

### refund-period-reports
- Refunds: receipt number → `findSaleForRefund` → per-line steppers (0..refundable), return/waste for tracked products, tender (cash default) → `requirePermission('refund')` → `commitRefund` → `openDocument`.
- Period: open period (`NoPeriodPrompt` / `OpenPeriodDialog`); `X read` → `requirePermission('xRead')` → `runXRead` → `openDocument`; `Z close` → `requirePermission('openClosePeriod')` (hold the auth for the wizard) → `prepareZClose(ctx, basket)` (warn `N tabs are open…`) → counted cash keypad → `previewZClose` → `Confirm Z close` → `confirmZClose(ctx, auth, basket, declared)` → `openDocument` → `refreshPeriod()`.
- Reports: date range (`TextField type="date"`, default `todayLocal(ctx)`) → `Run report` → `requirePermission('salesReports')` → `runProductSalesReport` / `runVatReport` → `DataTable`. Figures appear only after Run (D-070).

### backoffice
- `BackOfficeMenu`: links to Products, Categories, Deals, Staff, Stock, Settings, Backup, plus Members (`#/members`) and Bookings (`#/bookings`).
- Every Save/submit is gated: `editCatalogue`, `stockControl`, `manageMembersStaffSettings`, `backup`. Lists are visible to everyone.
- Settings save → `refreshSettings()` and `useBasketStore.getState().refresh()`.
- Stock: goods in, adjustment/waste, low-stock list with `data-testid="low-stock-list"`.
- Backup: export → `exportBackup` → `downloadTextFile(fileName, json)` → `refreshBanners()`; import → file → `checkBackupFile` → show summary → type `REPLACE` → `requirePermission('backup')` → `importBackup(ctx, auth, { file, confirmation, importerName: session.name })` → `afterBackupImport()`.

---

## 8. File ownership

| Package | Owns | Placeholder files to replace (keep export names) |
|---|---|---|
| UI foundation (architect) | `src/app/**`, `src/store/**`, `src/components/**`, `src/main.tsx`, `index.html`, `src/screens/setup/**`, `src/screens/login/**`, `tests/e2e/helpers.ts`, `tests/e2e/smoke.spec.ts`, `tests/e2e/setup-login.spec.ts`, `tests/unit/**` (stores/components/app), `docs/ui-plan.md` | — |
| **till** | `src/screens/till/**`, `tests/e2e/pkg-till.spec.ts` | `src/screens/till/TillScreen.tsx` (`TillScreen`) |
| **backoffice** | `src/screens/backoffice/**`, `tests/e2e/pkg-backoffice.spec.ts` | `BackOfficeMenu.tsx`, `ProductsScreen.tsx`, `CategoriesScreen.tsx`, `DealsScreen.tsx`, `StaffScreen.tsx`, `StockScreen.tsx`, `SettingsScreen.tsx`, `BackupScreen.tsx` in `src/screens/backoffice/` |
| **pay** | `src/screens/pay/**`, `tests/e2e/pkg-pay.spec.ts` | `src/screens/pay/PayScreen.tsx` (`PayScreen`) |
| **tabs-bookings-members** | `src/screens/tabs/**`, `src/screens/bookings/**`, `src/screens/members/**`, `tests/e2e/pkg-tabs-bookings-members.spec.ts` | `tabs/TabsScreen.tsx`, `bookings/BookingsScreen.tsx`, `bookings/BookingDetailScreen.tsx`, `members/MembersScreen.tsx` |
| **refund-period-reports** | `src/screens/refunds/**`, `src/screens/period/**`, `src/screens/reports/**`, `tests/e2e/pkg-refund-period-reports.spec.ts` | `refunds/RefundScreen.tsx`, `period/PeriodScreen.tsx`, `reports/ProductSalesReportScreen.tsx`, `reports/VatReportScreen.tsx` |

Add more files freely inside your folders (sub-components, `*.module.css`). Component tests for your package go in `tests/unit/<package>-*.test.tsx` (jsdom: first line `// @vitest-environment jsdom`). Shared files (`src/app`, `src/components`, `src/store`): additive, backward-compatible edits only when unavoidable; re-read first; note them in your summary.

---

## 9. E2E helpers and selectors (`tests/e2e/helpers.ts`)

Run: `CI=1 PW_PORT=<your port> npx playwright test tests/e2e/<spec>` (builds into `dist-e2e-<port>` and writes results to `test-results-<port>`; delete both when done). Projects `tablet-landscape` (1280 × 800) and `phone-portrait` (390 × 844); every spec runs at both.

| Helper | Does |
|---|---|
| `MANAGER`, `STAFF`, `SUPERVISOR`, `CLUB_NAME` | Morgan Manager 1234, Sam Staff 1111, Sue Supervisor 2222, Oakfield Golf Club (D-099) |
| `freshStart(page)` | deletes `club-epos`, clears storage, reloads to Setup |
| `firstRun(page, { managerName?, pin?, clubName?, loadSample? = true })` | completes Setup; waits for `#/till` with the manager logged in |
| `login(page, pin)` / `lock(page)` | PIN keypad + Enter, waits for `#/till` or `#/pay` / Lock, waits for the keypad |
| `enterPin(scope, pin)` / `approveOverride(page, pin)` | presses a PinKeypad in `scope` / approves the open override dialog |
| `navigate(page, linkName)` | Menu → link (`Till`, `Tabs`, `Bookings`, `Members`, `Refunds`, `Period`, `Product sales report`, `VAT report`, `Back office`) |
| `openPeriod(page, floatPence = 10000)` | from the Till's `no-period` prompt via the UI (log in as the manager) |
| `enterMoney(scope, pence)` | `Clear` then digits on a NumericKeypad in `scope` |
| `money(pence)`, `parseMoney(text)`, `readMoney(locator)`, `expectMoney(locator, pence)` | `£` formatting/parsing like `formatPence` |
| `waitForDocument(context, action)` | returns the popup page (`await expect(popup).toHaveTitle('Receipt 3F9C-000001')`, `'X read'`, `'Z report 1'`) |
| `readStore(page, store)`, `readAuditEvents(page)` | reads IndexedDB `club-epos` **without a version** (D-119) |
| `isNarrow(page)`, `expectNoHorizontalScroll(page)` | phone layout check / no sideways scroll of the page, `<main>` or the topmost open dialog (DataTable regions and tab lists may scroll inside themselves) |

Stable selectors: buttons by accessible name with `exact: true` (`Pay`, `Void`, `No sale`, `Member`, `Tab`, `Booking`, `Exact`, `Cash`, `Card`, `£5`, `£10`, `£20`, `£50`, `Complete sale`, `Open period`, `X read`, `Z close`, `Confirm Z close`, `Lock`, `Menu`, `Enter`, `Reprint`); product buttons by exact product name; category tabs by `getByRole('tab', { name })`; dialogs by `getByRole('dialog', { name: <title> })` and scope keypad presses to the dialog (the page behind a modal is `inert`). Test ids: `basket-total`, `basket-bar-total` (phone bar), `amount-due`, `remaining`, `change-due`, `member-badge`, `booking-badge`, `tab-badge`, `deal-line`, `member-discount-line`, `deposit-line`, `receipt-fallback`, `low-stock-list`, `override-dialog`, `open-period-dialog`, `float-amount`, `no-period`, `period-status`, `current-staff`, `login-screen`, `backup-reminder`, `storage-warning`, `toast`, `basket-bar-count` (phone bar), `tender-row`, `pay-error`, `pay-no-period`, `booking-deposit-in-progress`, `backup-payment-in-progress`, `basket-error` (the till's pricing banner; `basket-total` / `basket-bar-total` then read `Unavailable` / `Total unavailable`, D-138). Banners are in flow (tolerate `storage-warning`: headless Chromium usually refuses persistence, D-112). `page.clock.install()` before the first navigation controls auto-lock and the lockout countdown.

---

## 10. Known limits

- One app tab per device (D-113). The Pay session is lost on refresh (D-033).
- The backup/storage banners are computed at sign-in; call `refreshBanners()` after actions that change them.
- `#/dev/components` exists only under `npm run dev`.
