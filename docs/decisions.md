# Club EPOS — Decisions

**Status:** binding for every station (builders, tester, reviewer, fixer).
**Source of truth:** `docs/design-spec.md`. This file resolves what the spec leaves open or ambiguous. `docs/architecture.md` maps the decisions onto modules.
**Money:** all amounts are integer pence. `£x.xx` in the text is for readability only; examples give exact pence.

How to use this file:

- Code comments and tests cite decisions as `D-nnn`. IDs are stable: never renumber. A new decision takes the next free number (D-119 onwards) and goes under its group.
- If the spec and a decision disagree, raise it with the reviewer rather than choosing silently. The spec wins unless a decision explicitly refines it.
- Worked examples are test cases: the rules and data suites should assert them exactly.

## Conflicts resolved between the two research passes

| Topic | Pricing/reports researcher | Data/flows researcher | Chosen |
|---|---|---|---|
| Basket line identity | snapshot lines; merge by product + price snapshot | unique by productId, unpriced | **Unique by productId, unpriced.** Priced from the current product; snapshotted into SaleLines at Pay open (D-008, D-009) |
| Tab lines | snapshot lines | `{productId, qty}`, repriced | **`{productId, qty}`, repriced at current prices** (D-062) |
| Time zone | Europe/London via Intl | device local zone | **Europe/London, explicit** (tests run on a UTC machine) (D-102) |
| Keypad maximum | 7 digits (£99,999.99) | £9,999.99 | **7 digits, 9,999,999p** for tenders, float, declared cash, deposits (D-006) |
| Deal `pricePence` | 0..9,999,999 | 1..999,999 | **1..999,999** (D-013) |
| Refund "waste" stock | +q refund, −q waste | no movement | **+q 'refund' and −q 'waste'**: net 0, and the waste is recorded (D-039) |
| Refund matching | by original line index | by productId | **`refundOfLineIndex`** on refund lines (D-036) |
| In-progress tenders | persisted in the draft | discarded on lock, removable | **In memory; survive auto-lock, lost on refresh; no single-tender removal; "Cancel payment" discards all** (D-033) |
| Attachable bookings | any open booking | open with balance > 0 | **Open with balance > 0** (D-028) |
| Where validation lives | pure `validateSale` in rules | repositories validate | **Pure validators in rules, enforced by services; the data layer enforces persistence integrity and transactional re-checks only** (D-106) |
| Void audit detail | `nameAtSale` | `productName`, `tabId?` | **`{productId, productName, qty, unitPricePence, tabId?}`** (D-084) |
| Z number scope | global max | per device | **Per device** (D-061) |
| Deposit receipt | "No VAT" note | "Deposit balance now" | **Both** (D-108) |

---

## 1. Money & rounding

### D-001 Integer pence with fixed input caps
- **Spec:** §3.2, §4, §7; CLAUDE.md money rule.
- **Decision:** All money is a JS `number` holding an integer count of pence, with `Number.isSafeInteger` true and never `-0`. No floats or decimal pounds anywhere in rules or data. Every multiply-then-divide goes through the BigInt-backed helpers in `src/rules/money.ts` (`roundHalfUp`, `mulDivRoundHalfUp`, `allocate`). Plain sums use ordinary addition. The same caps apply in the UI, the validators and the services:
  - Product `pricePence`: 0..999,999 (`MAX_PRICE_PENCE`, £9,999.99).
  - Deal `pricePence`: 1..999,999.
  - Line qty: 1..999.
  - Money keypad values (tenders, float, declared cash, deposit amount): up to 9,999,999 (`MAX_KEYPAD_PENCE`, £99,999.99). Float and declared cash may be 0; a deposit is at least 1.
  - Deal `n`: 2..99; `m`: 1..n−1.
  - `memberDiscountPercent`: an integer 0..100.
  - `vatRate`: an integer 0..100. The UI offers 20, 5 and 0 (D-022).
  - Money helpers throw `RangeError` on a non-integer or unsafe input, or an unsafe result. They fail loudly and never round silently.
- **Why:** Integer pence is mandated. BigInt intermediates remove any overflow reasoning.
- **Example:** Maximum line gross = 999 × 999,999 = 998,999,001p (safe). An allocation numerator of 998,999,001 × 998,999,001 ≈ 1e18 would lose precision as a Number but is exact in BigInt.

### D-002 Round half up (symmetric) for integer rationals
- **Spec:** §7.3, §7.5, §7.2.
- **Decision:** `roundHalfUp(num, den)` with den > 0, computed in BigInt: a = |num|; q = a / den (truncating); if 2·(a mod den) ≥ den then q += 1; result = sign(num)·q as a Number. This rounds halves away from zero, so `roundHalfUp(-x, d) === -roundHalfUp(x, d)`, and it never returns −0. `mulDivRoundHalfUp(a, b, den) = roundHalfUp(BigInt(a)·BigInt(b), den)`. Every rounding in the app uses it:
  - member discount = `mulDivRoundHalfUp(base, percent, 100)`;
  - line VAT = `mulDivRoundHalfUp(final, rate, 100 + rate)`;
  - proportional share = `mulDivRoundHalfUp(total, weight, sumOfWeights)`.
  Never use `Math.round`.
- **Why:** Exact for every input. `Math.round(-2.5)` is −2, which is asymmetric, and it involves floats.
- **Example:** (5,2)→3; (−5,2)→−3; (7,3)→2; (−1,3)→0. Member discount 1230×15/100 = 184.5→185. VAT on 765 @20% = 15300/120 = 127.5→128. VAT on 2295 = 382.5→383. VAT on 1250 = 208.33→208.

### D-003 No negative zero anywhere
- **Spec:** §3.2, §6.8, §10.1.
- **Decision:** `negate(p) = p === 0 ? 0 : -p`. Every sign flip uses it and never unary minus: building refund lines, printing positive discounts as negatives, and computing magnitudes such as `refundsPence`. `validateSale` rejects any money field where `Object.is(v, -0)`.
- **Why:** In this repo's Vitest, `expect(-0).toBe(0)` and `toEqual(0)` both fail, and `Intl` prints `-£0.00`.
- **Example:** Refunding a line whose `dealDiscountPence` is 0 stores `dealDiscountPence: 0`. `formatPence(negate(0))` is `'£0.00'`.

### D-004 Proportional allocation (one shared helper)
- **Spec:** §7.2 last bullet, §7.3 third bullet.
- **Decision:** `allocate(total, weights, priority)` returns integer shares.
  - Preconditions: the weights are non-negative integers, 0 ≤ total ≤ Σweights, and `priority` is a permutation of the indices.
  1. W = Σweights. If total = 0 or W = 0, return all zeros.
  2. share_i = `mulDivRoundHalfUp(total, w_i, W)`.
  3. diff = total − Σshare.
  4. Walk `priority` until diff = 0. When diff > 0, add min(diff, w_i − share_i). When diff < 0, subtract min(−diff, share_i).
  - The result always satisfies 0 ≤ share_i ≤ w_i and Σshare = total.
  - Deal groups use weights = the unit prices and priority = the group's sort order (D-016).
  - Member discount uses weights = the post-deal line amounts and priority = post-deal amount DESC, then line index ASC (D-020).
- **Why:** In normal cases the whole remainder lands on `priority[0]`, which is the spec's "highest-priced unit" or "largest line". The clamped walk only matters in edge cases, where it prevents a negative or over-sized share.
- **Example:** (200,[450,400,350]) → [75,67,58]. (100,[450,450,450]) → [34,33,33]. (185,[410,410,410]) → 62,62,62 = 186, diff −1 → [61,62,62]. (1,[450,450]) → [0,1]. Cascade case: (3,[401,401,401,401,399]) → 1,1,1,1,1 = 5, diff −2 → [0,0,1,1,1].

### D-005 Money display format
- **Spec:** §6.10; CLAUDE.md "amounts shown as £1.23".
- **Decision:** `formatPence(p)` uses integer maths only (no `p/100`, no `Intl`). The output is `'-'` if p < 0, then `'£'`, whole pounds with `,` thousands separators, `.`, and two-digit pence. Amounts stored as positive but printed as subtractions go through `formatPence(negate(v))`: deal savings, member discount, deposit applied, and on X/Z the deal discounts, member discounts and refunds. Percentages print as `15%`; counts as plain integers.
- **Example:** 0→`£0.00`; 5→`£0.05`; 450→`£4.50`; 123456→`£1,234.56`; 100000000→`£1,000,000.00`; −255→`-£2.55`; a member discount of 173 prints `-£1.73`.

### D-006 Money keypad entry (digits as pence)
- **Spec:** §6.4, §6.11.
- **Decision:** Every money keypad (Pay custom amount, deposit amount, opening float, declared cash) enters digits as pence. Keys are 0–9, `00`, backspace and C. The value grows as value·10 + digit (`00` counts as two zeros). At most 7 digits are accepted and any further key press is ignored. The display is `formatPence(value)`. A value of 0 disables the buttons that need an amount. The PIN keypad is a separate component (D-073).
- **Example:** 2,0,0,0 → 2000 (£20.00). 5 → 5 (£0.05). 1,00 → 100. 0,0,7 → 7. 9,9,9,9,9,9,9 → 9,999,999, and an 8th digit is ignored.

### D-007 Back-office price text parsing
- **Spec:** §6.9.
- **Decision:** `parsePoundsToPence(text, maxPence)`: trim, strip one optional leading `£`, require `/^\d+(\.\d{1,2})?$/`, then pence = pounds·100 + the fraction right-padded to 2 digits, using string maths (never `parseFloat`). It rejects empty input, signs, commas, more than 2 decimals, a leading `.`, and values above `maxPence` (999,999 for both product and deal prices). Edit fields show the stored value as `penceToPoundsText` (`450` → `4.50`).
- **Example:** `'4.5'`→450; `'4.50'`→450; `'£12'`→1200; `'0.05'`→5; `'4.35'`→435 (not 434.999…). These are errors: `'4.505'`, `'-1'`, `'1,000'`, `'.5'`, `''`.

### D-120 Price text for editing has no thousands separators
- **Spec:** §6.9; refines D-007.
- **Decision:** `penceToPoundsText(p)` prints whole pounds and two-digit pence with no `£`, no sign and **no thousands separators**, so an edit field always round-trips through `parsePoundsToPence`, which rejects commas. It throws `RangeError` for a negative or non-integer value, because prices are never negative.
- **Why:** The stub said "formatPence without the £ and sign", which would print `1,234.56`; saving the form unchanged would then fail validation.
- **Example:** 450 → `4.50`; 123456 → `1234.56` (where `formatPence` shows `£1,234.56`).

## 2. Basket & pricing lifecycle

### D-008 Basket lines: one per product, unpriced
- **Spec:** §4 SaleLine/Tab, §6.3, §6.6, §7.
- **Decision:** Basket, draft and tab lines are `{productId, qty}` and unique by productId. Tapping a product already in the basket adds 1 to its line in place. A new product is appended at the end. qty is an integer 1..999; a tap at 999 is ignored with a toast "Maximum quantity is 999". A line reduced to 0 is removed, which is a void (D-085). Line order is the array position: it is the receipt order and the tie-break order for deals and member discount. Sale lines are therefore unique by productId for kind `sale`.
- **Why:** One line per product makes tabs, drafts and refunds unambiguous. Deals work at unit level, so pricing is identical either way.
- **Example:** Tap Club Bitter, Fairway Lager, Club Bitter → `[Club Bitter ×2, Fairway Lager ×1]`.

### D-009 Prices come from the current product; snapshot at Pay
- **Spec:** §4 ("Sale lines copy the product name, price and VAT rate at the time of sale"), §7.
- **Decision:** A basket or tab is always priced from the current product record: price, VAT rate, member eligibility and name. Inactive or soft-deleted products still price, because the record still exists. The snapshot into `SaleLine` (nameAtSale, unitPricePence, vatRate) happens when Pay opens (D-011) and is what the sale stores. Later product edits never change stored sales. A price edit while a basket or tab is open does reprice it.
- **Example:** A tab holds 2 × Club Bitter at 420. The manager changes the price to 440. Settling the tab charges 880 before discounts.

### D-010 Pricing function contract
- **Spec:** §3, §7.
- **Decision:** `priceBasket(input)` in `rules/pricing.ts` is pure.
  - Input: `{lines: PricingLine[], deals: Deal[], at, memberDiscountPercent: number|null, depositBalancePence: number|null}`. null means no member / no booking attached.
  - Output: `PricedBasket`. Each line carries `grossPence, dealDiscountPence, memberDiscountPence, finalPence, vatPence, netPence`. The basket carries `dealLines, grossPence, dealDiscountPence, memberDiscountPence, subtotalPence (= Σfinals), depositAppliedPence, totalPence, vatSummary`.
  - Steps: gross → deals (D-014..D-018) → member discount on post-deal amounts (D-020) → final → line VAT (D-021) → deposit applied (D-023) → total.

### D-011 Pay freeze (pricing instant)
- **Spec:** §6.4, §7.
- **Decision:** The till reprices on every basket change with `at = now`, for display. When Pay opens, the basket is priced once more with `at = now`, the current `memberDiscountPercent` and the booking balance read at that moment. That result is frozen for the whole Pay session, and the committed sale stores exactly the frozen figures. `sale.createdAt` is the commit instant. Leaving Pay drops the freeze, which is only allowed with no tenders taken, or after "Cancel payment" (D-033).
- **Why:** Tenders are taken against a fixed amount due, and the receipt always equals what the customer was shown.
- **Example:** A deal has `endsAt` 2026-09-26T21:00:00.000Z. Pay opened at 20:59:30Z and the last tender was taken at 21:00:10Z. The sale keeps the deal discount.

## 3. Deals

### D-012 Deal validity window
- **Spec:** §4 Deal, §7.2.
- **Decision:** A deal applies at instant `at` iff all of these hold:
  - `active === true`;
  - `deletedAt` is absent;
  - `startsAt` is absent, or `at ≥ startsAt` (start inclusive);
  - `endsAt` is absent, or `at < endsAt` (end exclusive).

  Compare with `Date.parse`. The form uses Europe/London dates: `startsAt` = London midnight at the start of the start date, and `endsAt` = London midnight at the start of the day after the end date (`dealWindowFromDates`).
- **Example:** End date 30/09/2026 → `endsAt = 2026-09-30T23:00:00.000Z`. At 22:59:59.999Z the deal applies; at 23:00:00.000Z it does not. The range 01/10/2026–31/10/2026 → `startsAt 2026-09-30T23:00:00.000Z`, `endsAt 2026-11-01T00:00:00.000Z`.

### D-013 Deal validation
- **Spec:** §4 Deal, §6.9.
- **Decision:** On save:
  - name: 1..40 chars after trimming;
  - type: `nForPrice` or `nForM`;
  - n: an integer 2..99;
  - nForPrice: `pricePence` is an integer 1..999,999 and `m` is absent;
  - nForM: `m` is an integer with 1 ≤ m < n and `pricePence` is absent;
  - productIds: de-duplicated, at least one, each a non-deleted product;
  - if both dates are set, end date ≥ start date.

  A deal priced at or above realistic group totals is allowed; it just never applies (D-015). Pricing ignores productIds that are not in the basket.
- **Example:** `{nForM, n:3, m:3}` is rejected. `{nForPrice, n:1, pricePence:500}` is rejected. `{nForPrice, n:2, pricePence:0}` is rejected. `{nForM, n:3, m:2}` is OK.

### D-014 Unit expansion, sort order and grouping
- **Spec:** §7.2 bullets 1–4.
- **Decision:** Each basket line i, in basket order, expands into qty units `{lineIndex:i, unitIndex:k, productId, pricePence: unitPrice}`. A unit qualifies for deal D iff its productId is in `D.productIds`; member eligibility doesn't affect deals. Qualifying units are sorted by pricePence DESC, then lineIndex ASC, then unitIndex ASC. This is a total order, so results never depend on sort stability. Groups are consecutive runs of n from the start. The last (count mod n) units are leftovers: the cheapest, and among equals the latest added.
- **Example:** 2 for £8 (nForPrice n=2, 800) on Lager ×3 @450: group {u0,u1} saves 100 and u2 is left over. The line: gross 1350, deal 100, final 1250, VAT 208, net 1042.

### D-015 nForPrice saving; groups that don't save
- **Spec:** §7.2 bullet 3, §10.1.
- **Decision:** Group saving = Σ(group unit prices) − `pricePence`. A group with saving ≤ 0 is not applied, and its units are **not consumed**: they stay available to deals evaluated later (D-018). The list is sorted descending, so no later group of the same deal saves more. Evaluation may therefore stop at the first failing group.
- **Example:**
  - Equal prices, 2 for £8 on Lager ×2 @450: saving 100, split 50/50. The line has deal 100, final 800, VAT 133, net 667.
  - Mixed prices, 3 for £10 on A 350, B 450, C 400 (basket order A,B,C): sorted B,C,A; saving 1200−1000 = 200 → B 75, C 67, A 58. Finals: A 292 (VAT 49), B 375 (VAT 63), C 333 (VAT 56); total 1000.
  - Price-raising deal, 2 for £10 on Lager ×2 @450: saving −100, not applied; final 900, VAT 150.
  - Second group fails, 3 for £10 on A ×2 @500, B ×2 @400, C ×3 @200: group 1 (500,500,400) saves 400 with shares 143,143,114, giving line A deal 286 and line B deal 114. Group 2 (400,200,200) = 800 saves −200 and is not applied. C has deal 0. Total 2000.

### D-016 nForM free units and spreading
- **Spec:** §7.2 bullets 4 and 6, §10.1.
- **Decision:** In each group (already sorted DESC), the last n−m units are free: saving = the sum of their prices. The group applies only when saving > 0. The saving is spread over **all** n units of the group in proportion to price, with `allocate(saving, prices, [0..n-1])`. Saving is never assigned only to the free units.
- **Example:** 3 for 2 on A 500, B 400, C 300: saving 300. Shares 125, 100, 75. Finals 375, 300, 225 (total 900). VAT 63, 50, 38. Nets 312, 250, 187. Rounding case: A 450, B 420, C 390 → saving 390 → shares 139, 130, 121 → finals 311, 290, 269.

### D-017 Unit savings → line figures and deal lines
- **Spec:** §6.3, §6.10, §7.2.
- **Decision:** `line.dealDiscountPence` = the sum of that line's unit shares across all applied groups of all deals. Pricing returns `dealLines: [{dealId, name, groupCount, savingPence}]`, one per deal applied at least once, in canonical deal order (D-018). Σ savingPence = Σ line deal discounts. `Sale.dealLines` stores them so receipts reprint without repricing; deposit and refund sales store `[]`. The basket and receipt show `{name} x{groupCount}` (`x1` omitted) with amount −savingPence.
- **Example:** 2 for £8 on Lager ×5 @450: 2 groups saving 100 each and 1 leftover. The line has deal 200, final 2050. dealLines `[{name:'2 for £8', groupCount:2, savingPence:200}]` prints `2 for £8 x2  -£2.00`.

### D-018 Overlapping deals: search and tie-break
- **Spec:** §7.2 bullets 2 and 5, §10.1.
- **Decision:** Candidates are the deals valid at `at` that have at least n qualifying units in the basket. Pricing sorts them into canonical order: `createdAt` ASC, then `id` ASC by plain string comparison, whatever the input order.
  - Evaluating an order P processes the deals in turn. Each deal takes all of its qualifying units not yet consumed, sorts and groups them (D-014), and consumes only the units in its applied groups.
  - With ≤ 6 candidates (`MAX_PERMUTED_DEALS`), every permutation is evaluated, generated in lexicographic order of canonical positions (identity first; not Heap's algorithm). The first permutation with the strictly greatest total saving is kept, so ties go to the lexicographically earliest order.
  - With > 6 candidates, greedy: repeatedly apply the remaining deal with the strictly greatest saving on unconsumed units (the earliest canonical deal wins ties), and stop when none saves > 0.
- **Why:** Deterministic, at most 720 cheap evaluations, and faithful to "collect the qualifying units not already used by another deal".
- **Example:** Basket Lager ×1 @450, Bitter ×3 @420. Deal A (created first) is "Any 2 pints £7": nForPrice n=2, 700, {lager, bitter}. Deal B is "Bitter 3 for 2": nForM n=3 m=2, {bitter}.
  - Order [A,B]: A forms (450,420) saving 170 and (420,420) saving 140, total 310; B gets nothing.
  - Order [B,A]: B saves 420; A has only the Lager left.
  - 420 > 310, so [B,A] wins. Lager: deal 0, final 450. Bitter: deal 420 (140 per unit), final 840. Total 1290. dealLines `[Bitter 3 for 2 −£4.20]`.
  - Tie: two identical "2 for £8" deals X (created first) and Y on Lager ×2 @450 both save 100, so the saving is credited to X.

### D-121 Pricing ignores deals with invalid parameters
- **Spec:** §7.2; refines D-013 and D-018.
- **Decision:** A deal can be a candidate only if its parameters are within the D-013 ranges: a known `type`; `n` an integer 2..99; for `nForPrice`, `pricePence` an integer 1..999,999; for `nForM`, `m` an integer 1..n−1. Pricing skips any other deal silently and never throws for it. Pricing ignores the field the type does not use (`m` on nForPrice, `pricePence` on nForM); `validateDeal` still rejects it on save. The shared check is `rules/deals.isDealWellFormed`.
- **Why:** D-089 only type-checks imported rows, so a malformed deal can reach pricing. Blocking the till over it would be worse than ignoring the deal.
- **Example:** `{nForPrice, n:2, pricePence:0}` on Lager ×2 @450 prices at 900 with no deal line, where a literal reading would make both pints free.

### D-126 The last deal end date is 30/12/9999
- **Spec:** §6.9; refines D-012, D-013 and D-117 (the same limit `localDateRange` already applies to report ranges, D-103).
- **Decision:** `validateDeal` rejects an end date whose next day is not a valid `YYYY-MM-DD` date, with field `endDate` and the message "End date must be 30/12/9999 or earlier". In practice that is only 31/12/9999. A start date of 31/12/9999 is allowed. `dealWindowFromDates` still throws `RangeError` for such an end date, because reaching it is a programming error once the validator has run.
- **Why:** `endsAt` is London midnight at the start of the day **after** the end date (D-012). For 31/12/9999 that day is `10000-01-01`, which has no `YYYY-MM-DD` form and no 24-character ISO instant (D-049). A browser date input accepts year 9999, so the validator must return a result rather than throw (D-117), and `saveDeal` then fails with `VALIDATION`.
- **Example:** End date 30/12/9999 → `endsAt 9999-12-31T00:00:00.000Z`. End date 31/12/9999 → `{ok:false, errors:{endDate:'End date must be 30/12/9999 or earlier'}}`.

## 4. Member discount

### D-019 When member discount applies
- **Spec:** §4 Settings, §6.5–§6.7, §7.3.
- **Decision:** It applies only while a member is attached. Pricing gets `memberDiscountPercent = null` otherwise. The percent is `settings.memberDiscountPercent` (default 15), read at pricing time and frozen at Pay open. Only active members can be attached; a member deactivated after attaching stays attached. A tab's member carries into the basket when the tab is loaded. `Sale.memberId` is stored whenever a member is attached, even when the discount is 0. Deposit sales never carry a member or discount. Refunds copy the original `memberId` for reference only. The percent is not stored on the sale; receipts show the member number.
- **Example:** At 10% with a member attached and base 1000: discount 100. The same basket without a member: 0, and no member line.

### D-020 Member discount base, rounding and spreading
- **Spec:** §7.3, §10.1.
- **Decision:** postDeal_i = gross_i − deal_i. base = Σ postDeal over lines with `memberDiscountEligible`. discount = `mulDivRoundHalfUp(base, percent, 100)`. It is spread with `allocate(discount, postDeal of eligible lines, priority = postDeal DESC then line index ASC)`. Ineligible lines get 0; an eligible line with postDeal 0 gets 0. `Sale.memberDiscountPence` = Σ line member discounts = discount.
- **Example:**
  - Half-penny with a deal and a 0% line: Lager ×3 @450 with "3 for 2" (deal 450, postDeal 900) plus Crisps ×2 @125 at 0% (postDeal 250). Base 1150 → 172.5 → 173. Shares 135 (135.39) and 38 (37.61). Lager: gross 1350, deal 450, member 135, final 765, VAT 128, net 637. Crisps: gross 250, member 38, final 212, VAT 0. Total 977.
  - Without deals: Lager ×2 @450 + Crisps 130 (0%). Base 1030 → 154.5 → 155. Lager 135, Crisps 20. Total 875.
  - Remainder tie: three eligible lines of 410. Base 1230 → 185. Shares 62,62,62 = 186, diff −1 on line 0 → [61,62,62]. Finals 349, 348, 348.
  - Ineligible item: Lager ×2 @450 + Cigar 1200 (ineligible). Base 900 → 135, all on the Lager. Total 765 + 1200 = 1965.

## 5. VAT

### D-021 VAT per line and VAT summaries
- **Spec:** §4, §6.10, §7.5, §10.1.
- **Decision:** For sale-kind lines, `vatPence = mulDivRoundHalfUp(final, rate, 100+rate)` and net = final − vat. Net is derived and never stored. Refund-line VAT is the cumulative share of the original line's VAT (D-037), not this formula. A VAT summary has one row per rate present, sorted by rate DESC: gross = Σ line finals, vat = Σ line VAT, net = gross − vat. Receipts, X/Z and the VAT report all build it this way, never recomputing VAT from a rate total. A deposit applied changes neither line finals nor VAT, so a receipt's VAT summary covers the full line finals.
- **Example:** Lager 450: VAT 75, net 375. Wine 2295: VAT 383, net 1912. Crisps ×2 @125 at 0%: VAT 0. Basket total 2995. Summary: 20% net 2287, VAT 458, gross 2745; 0% net 250, VAT 0, gross 250. Why line sums matter: two separate Wine and Prosecco lines at 2295 each give VAT 383 + 383 = 766, whereas 4590 × 20/120 = 765. The summary shows 766.

### D-022 VAT rates offered
- **Spec:** §4, §9.
- **Decision:** Products choose `vatRate` from `VAT_RATE_CHOICES = [20, 5, 0]` (default 20). The rules accept any integer 0..100.

## 6. Deposits & bookings

### D-023 Deposit applied on the final bill
- **Spec:** §6.7, §7.4, §7.6, §10.1.
- **Decision:** `depositAppliedPence = max(0, min(balance, Σfinals))`, or 0 with no booking attached. It is sale-level only: line figures and VAT are unchanged. `totalPence = Σfinals − depositApplied`, which is always ≥ 0. The basket shows a "Deposit taken" line and the receipt a "Deposit applied" line, each with amount −depositApplied and only when > 0. `Sale.bookingId` is stored whenever a booking is attached.
- **Example:** Basket Wine ×4 @2295 = 9180 (VAT 1530).
  - Balance 5000: applied 5000, total 4180, balance afterwards 0.
  - Balance 9180: applied 9180, total 0.
  - Balance 10000: applied 9180, total 0, and 820 stays on the booking.

  In all three cases the VAT summary is 20% net 7650, VAT 1530, gross 9180.

### D-024 Deposit sale record and its VAT treatment
- **Spec:** §6.7, §7 final paragraph, §4 Sale.
- **Decision:** A deposit sale is `{kind:'deposit', bookingId, lines:[], dealLines:[], memberDiscountPence:0, depositAppliedPence:0, totalPence: amount, tenders, changePence}`, with no memberId, tabId or refundOfSaleId. Normal tender rules apply: split is allowed and cash may give change. It needs an open period and takes a receipt number. It has **no VAT**, because it is a prepayment; VAT is accounted once, on the final bill's lines. It is excluded from gross sales, net takings, the product sales report and the VAT report, and it counts in cash/card totals and "deposits taken". Deposit sales cannot be refunded in v1.
- **Example:** A £50 cash deposit for "Smith wedding" is stored as `{kind:'deposit', lines:[], totalPence:5000, tenders:[{cash,5000}], changePence:0}`. The booking balance becomes 5000; X/Z shows depositsTaken +5000 and cashTendered +5000.

### D-025 Booking unused balance
- **Spec:** §4 ("unused deposit balance").
- **Decision:** balance = Σ `totalPence` of kind `deposit` sales with that bookingId − Σ `depositAppliedPence` of kind `sale` sales with that bookingId. Refund sales never change it. It is a data query, `SaleRepo.bookingBalance(bookingId)`, and the same computation is used inside `commitSale` for the re-check.
- **Example:** Deposits 20000 + 5000, then a final bill applying 18000, leave a balance of 7000.

### D-026 Booking fields and statuses
- **Spec:** §4 Booking, §6.7.
- **Decision:** Booking fields: type, name (1..60), date (`LocalDate`), notes (0..500, `''` when empty), status. Bookings are created `open` and only `open` bookings can be edited.
  - **Settle and cancel:** `open → settled` and `open → cancelled` are allowed only when the balance is exactly 0, including a booking that never took a deposit. Settling is always manual.
  - **Closed bookings:** `settled` and `cancelled` are terminal and read-only. They are hidden from attach-booking and take-deposit, and bookings are never deleted.
  - **Permission:** every booking action (create, edit, deposit, attach, detach, settle, cancel) uses permission `bookings`, which staff have.
  - **Type labels:** wedding "Wedding", society "Society day", eventTicket "Event tickets", other "Other".
- **Why:** The zero-balance rule means money can never be stranded on a closed booking.
- **Example:** Balance 820 after a bill: "Mark settled" is disabled. Apply the 820 to another bill for the same booking and it becomes enabled.

### D-027 Take deposit
- **Spec:** §6.7, §6.10.
- **Decision:**
  - **Preconditions:** the booking is `open` and a period is open. The amount is entered on the money keypad (1..9,999,999).
  - **Payment:** the same Pay screen and tender rules as a sale (`openDepositPayment` → `completePayment` with permission `bookings`).
  - **What it writes:** the deposit sale (D-024) with no stock movements. The till basket and draft are untouched.
  - **Receipt:** the deposit receipt is described in D-108.

### D-028 Attaching a booking to a bill
- **Spec:** §6.7, §7.4.
- **Decision:** The Booking button lists `open` bookings with balance > 0 (name, date, balance). Attaching sets `basket.bookingId` and replaces any booking already attached; detaching is free. Attaching needs an open period. Pay re-reads the balance at open (D-011). `commitSale` re-checks inside its transaction and fails with `BOOKING_NOT_OPEN` or `DEPOSIT_EXCEEDS_BALANCE` when either applies: nothing is written, the basket is kept, and the error is shown.
- **Example:** Balance 7000, bill 9000 → applied 7000, due 2000. Balance 7000, bill 5000 → applied 5000, due 0, and 2000 remains.

## 7. Tenders & Pay

### D-029 Tender rules: split, change, card cap
- **Spec:** §6.4, §8, §10.1.
- **Decision:** remaining = total − Σ tenders so far.
  - **Card:** the amount is the keypad amount, or `remaining` if the keypad is empty. It must be 1..remaining. Otherwise it is rejected with "Card can't be more than the balance (£x.xx)" and nothing is recorded.
  - **Cash:** the amount must be ≥ 1, with no upper limit.
  - **Completion:** after each tender, if Σ ≥ total the sale completes immediately with change = Σ − total. Change can therefore come only from a final cash tender, and it is always less than that tender.
  - **Storage:** tenders are stored separately in the order taken (never merged), at the amount tendered (the whole £20 note). The only types are `cash` and `card`.
  - The same rules apply to deposits.
- **Example:** Due 4180. Card 5000 is rejected. Card 3000 leaves 1180. Cash 1500 completes with change 320: tenders `[{card,3000},{cash,1500}]`. Due 977: cash £20 gives change 1023. Due 4180: cash 1000, then Card with an empty keypad takes 3180, change 0.

### D-030 Quick cash, Exact and Cash buttons
- **Spec:** §6.4.
- **Decision:** £5/£10/£20/£50 are always shown and are enabled while remaining > 0. Each tenders cash of its value, which is a partial tender if it is less than remaining. "Exact" tenders cash equal to remaining. "Cash" tenders the keypad amount and is disabled when the keypad is empty. The keypad clears after every tender.
- **Example:** Due 977: £5 leaves 477; Exact tenders 477 and completes with change 0, giving tenders `[{cash,500},{cash,477}]`. Due 320: £5 completes with change 180.

### D-031 Zero-total sale and empty basket
- **Spec:** §6.4, §6.7.
- **Decision:** Pay is disabled when the basket has no lines. If `totalPence` is 0 with at least one line, Pay shows "£0.00 due" and a single "Complete sale" button. The sale commits with `tenders: []` and `changePence: 0`, and writes stock movements and a receipt as normal.
- **Example:** Wine ×4 with a booking balance of 10000: applied 9180, total 0, tenders `[]`. The booking keeps 820.

### D-032 Sign convention and sale invariants
- **Spec:** §3.2, §4, §6.8, §8.
- **Decision:** For every kind, Σ tender amounts − changePence = totalPence.
  - **Sales and deposits:** tenders are > 0 and change ≥ 0.
  - **Refunds:** total ≤ 0, change is 0, and tenders are `[{chosen type, total}]` (negative) or `[]` when the total is 0.

  `rules/sale.validateSale` checks every rule below before any commit; services call it and throw `INVALID_SALE` on failure.
  - **All kinds:** money fields are safe integers and never −0, and the tender identity above holds.
  - **`sale`:**
    - at least one line, unique by productId, each qty ≥ 1;
    - per line: 0 ≤ deal ≤ gross, 0 ≤ member ≤ gross − deal, final = gross − deal − member, and vat = `lineVat(final, rate)`;
    - memberDiscountPence = Σ line member; Σ dealLines saving = Σ line deal;
    - 0 ≤ depositApplied ≤ Σfinals, and depositApplied > 0 needs a bookingId;
    - total = Σfinals − depositApplied;
    - replaying the tenders in order: each card tender ≤ the remaining amount, only the last tender may reach the total, change > 0 only when the last tender is cash and change < its amount, and a total of 0 has no tenders.
  - **`deposit`:** lines and dealLines are `[]`; bookingId is set; memberId, tabId and refundOfSaleId are absent; member discount and deposit applied are 0; the total is 1..9,999,999; the tender sequence is valid.
  - **`refund`:**
    - refundOfSaleId is set, with no bookingId or tabId;
    - at least one line, each with qty ≤ −1, a distinct `refundOfLineIndex` and `returnToStock` set;
    - final = qty·unit − deal − member, all ≤ 0;
    - dealLines `[]`; memberDiscountPence = Σ line member; depositApplied 0; total = Σfinals.
- **Why:** One identity for all kinds, so the report identities (D-042) follow by summation.
- **Example:** A refund of −255 by cash: tenders `[{cash,−255}]`, change 0, and −255 − 0 = −255. Sale S3: 3000 + 1500 − 320 = 4180.

### D-033 In-progress tenders (the Pay session)
- **Spec:** §6.2, §6.4, §8.
- **Decision:**
  - **Where it lives:** the Pay session (frozen pricing plus the tenders taken) lives only in memory, in the UI pay store. Nothing is written until completion.
  - **While tenders exist:** once any tender is taken the basket cannot be edited. Individual tenders can't be removed. The only exits are completing, or "Cancel payment" with a confirmation, which discards every tender. Staff then hand the money back or reverse the card payment, and cancelled tenders never reach any report.
  - **With no tenders taken:** "Back to basket" leaves Pay freely.
  - **Auto-lock:** the Pay session survives it (like the basket). After the next login the app returns to Pay if a Pay session exists.
  - **Refresh:** the Pay session is lost. The basket is restored from the draft (D-096) and staff must reverse any tenders already taken; this is a documented limitation.
- **Why:** A simple, consistent rule with no partial writes. The total can't change under tenders already taken.

### D-034 Commit failure
- **Spec:** §8.
- **Decision:** If `completePayment` throws, Pay stays open with its tenders and shows "Sale not saved: {message}". It offers "Try again", which re-commits the same frozen session, and "Cancel payment", which discards the tenders after confirmation and returns to the basket. No receipt opens, and the basket and draft are unchanged.

### D-123 A document that fails after its commit is not a failure
- **Spec:** §6.10, §8; refines D-034 and D-109.
- **Decision:** `completePayment`, `commitRefund` and `confirmZClose` build their document only after the write has committed. If building or rendering it then throws, the service still returns normally, with a minimal fallback document (same `<title>`: `Receipt {receiptNumber}` or `Z report {n}`, the CSP meta, and "… was saved, but the receipt could not be printed" plus the error text). The X read has nothing to commit, so it throws as usual.
- **Why:** A throw after the commit would make Pay show "Sale not saved" and offer "Try again", which would record the sale a second time.

## 8. Refunds

### D-035 Refund lookup and eligibility
- **Spec:** §6.8.
- **Decision:** Refunds need permission `refund` (checked at commit) and an open period. The search box normalises its input: trim and upper-case, then, if it matches `/^([A-Z0-9]{1,6})-(\d+)$/`, pad the digits to at least 6. The result is matched exactly against the unique `receiptNumber` index. Only kind `sale` can be refunded; a deposit or refund receipt shows "This receipt can't be refunded". Sales from closed periods can be refunded. The refund counts in the current period (D-040).
- **Example:** Typing `3f9c-42` finds `3F9C-000042`.

### D-036 Refundable quantities (by original line index)
- **Spec:** §6.8, §8.
- **Decision:** Refund lines carry `refundOfLineIndex`, the index into the original's lines. alreadyRefunded_j = Σ|qty| of refund lines with that index across every refund whose `refundOfSaleId` is the original's id. refundable_j = original qty_j − alreadyRefunded_j. The screen shows, per line, nameAtSale, the sold quantity, the quantity already refunded and a stepper 0..refundable. At least one line must be > 0. `commitSale` re-checks inside its transaction (`REFUND_EXCEEDS_AVAILABLE`).
- **Example:** Sold 3 and refunded 1 earlier, so the stepper allows at most 2.

### D-037 Refund line maths (cumulative allocation)
- **Spec:** §3.2, §6.8, §7, §10.1.
- **Decision:** For an original line with Q > 0 units and stored figures G = Q·unit, deal DD, member MD and VAT V: if r units have already been refunded and q are now being refunded (c = r + q), then for X ∈ {DD, MD, V}, share(X) = `mulDivRoundHalfUp(X, c, Q) − mulDivRoundHalfUp(X, r, Q)`. gross = q·unit, and final = gross − share(DD) − share(MD).
  - The refund line copies productId, nameAtSale, unitPricePence (positive) and vatRate from the original line.
  - It stores the other figures negated with `negate()`: qty −q, dealDiscountPence −share(DD), memberDiscountPence −share(MD), finalPence −final, vatPence −share(V).
  - It also carries `refundOfLineIndex` and `returnToStock`.

  Refund VAT is deliberately the cumulative share of the original VAT, not `lineVat()`. However a line's refunds are split, once the whole line is refunded they sum to exactly the negated original.
- **Example:** The original Lager line has qty 3, gross 1350, deal 450, member 135, final 765 and VAT 128.

  | Refund | deal | member | final | VAT | net |
  |---|---|---|---|---|---|
  | 1st, 1 unit | −150 | −45 | −255 | −43 (42.67) | −212 |
  | 2nd, 1 unit | −150 | −45 | −255 | −42 (85 − 43) | −213 |
  | 3rd, 1 unit | −150 | −45 | −255 | −43 (128 − 85) | −212 |
  | Sum | −450 | −135 | −765 | −128 | |

  If 2 units are refunded after the first instead: deal −300, member −90, final −510, VAT −85, net −425.

### D-038 Refund sale record
- **Spec:** §4 Sale, §6.7, §6.8.
- **Decision:** A refund sale has:
  - `kind: 'refund'`, `refundOfSaleId`, and `memberId` copied from the original if it had one;
  - no bookingId or tabId; `dealLines: []`;
  - `memberDiscountPence` = Σ line member (≤ 0), `depositAppliedPence: 0`, `totalPence` = Σ line finals (≤ 0);
  - **one** tender of the type the manager chose (default cash, whatever the original was paid with), or `[]` when the total is 0; `changePence: 0`;
  - periodId = the current open period; staffId = the logged-in user; a new receipt number.

  A deposit applied on the original is **not** restored to the booking; the refunded line value is paid out in the chosen tender. There is no cap linking a card refund to the original card amount.
- **Example:** A final bill of Wine ×4 @2295 had 5000 of deposit applied and 4180 paid. Refunding 1 Wine by cash: gross −2295, final −2295, VAT −383 (1530/4 = 382.5 → 383). Total −2295, tenders `[{cash,−2295}]`. The booking balance stays 0.

### D-039 Refund stock movements (return to stock or waste)
- **Spec:** §4 StockMovement, §6.8, §10.3 journey 6.
- **Decision:** Movements are written only for products whose **current** `stockTracked` is true; for untracked products the choice is hidden. They are written in the refund's `commitSale` transaction with `saleId` = the refund sale's id.
  - **Return to stock (the default):** one movement, +q with reason `refund` and note `''`.
  - **Waste:** two movements, +q `refund` and −q `waste` with note `'Refund - wasted'`. The net effect is 0, and the waste stays visible in stock history.

  The choice is also stored on the refund line (`returnToStock`) and in the refund audit detail.
- **Example:** Refund 1 Lager to stock: stock goes from 47 to 48. Refund 1 Lager as waste: two movements (+1, −1) and stock stays at 47.

### D-122 Receipt search drops leading zeros before padding
- **Spec:** §6.8; refines D-035.
- **Decision:** `normaliseReceiptQuery` trims and upper-cases the text. When it matches `/^([A-Z0-9]{1,6})-(\d+)$/`, leading zeros are dropped from the digits and they are then padded to at least 6. Other text is returned trimmed and upper-cased; empty text gives null.
- **Why:** Numbers above 999,999 never have leading zeros, so this only turns over-padded input into the stored form.
- **Example:** `3f9c-42` → `3F9C-000042`; `3f9c-0000042` → `3F9C-000042`; `3f9c-1234567` → `3F9C-1234567`.

### D-125 A partial refund's final never goes positive
- **Spec:** §6.8; refines D-037 so that it always satisfies D-032.
- **Decision:** D-037 rounds the deal and member shares separately. When a line's discounts take almost all of its gross, both can round up in the same slice, so D-037's final for that slice is −1p and the refund line would store finalPence +1. That is a refund that charges the customer; `validateSale` rejects it, and the refund could not be made. So the cumulative refunded figures after c of the line's Q units are:
  - deal = `mulDivRoundHalfUp(DD, c, Q)` and VAT = `mulDivRoundHalfUp(V, c, Q)`, exactly as D-037;
  - final = the largest D-037 final over 0..c units, where the D-037 final after j units is j·unit − `mulDivRoundHalfUp(DD, j, Q)` − `mulDivRoundHalfUp(MD, j, Q)`;
  - member = c·unit − deal − final.

  A refund of q units after r stores (negated) the figures after c = r + q minus the figures after r (`rules/refund.cumulativeRefund`), as before. For a valid original line (0 ≤ DD, 0 ≤ MD, DD + MD ≤ gross):
  - every figure of every refund slice is ≤ 0;
  - the final is D-037's whenever D-037's is valid; otherwise the member share is exactly 1p lower (a unit's deal share never exceeds its price, so the member share always has the penny);
  - the figures depend only on c, not on how earlier refunds were split, and at c = Q they are exactly the original line's.

  A slice's VAT is still its D-037 share, so a slice whose final comes out 0 can carry 1p of VAT, as D-037 already allowed; it nets off once the line is fully refunded.
- **Why:** It is the smallest change that keeps D-037's figures, including its worked table, and satisfies D-032. Only the member share moves, because the member discount is the last discount applied in pricing (§7.3).
- **Example:**
  - Lager ×2 @450, "2 for £8.99" (deal 1), member 100% (899), final 0, VAT 0. Refund 1 unit: deal −1, member −449, final 0, VAT 0 (D-037 alone: member −450, final +1). The second unit: deal 0, member −450, final 0.
  - A ×5 @100, deal 496, member 1, final 3, VAT 1. D-037 finals after 0..5 units are 0, 1, 2, 1, 2, 3; D-125 finals are 0, 1, 2, 2, 2, 3. Refunding 2, then 1, then 2 units stores (deal, member, final, VAT) = (−198, 0, −2, 0), then (−100, 0, 0, −1), then (−198, −1, −1, 0).

## 9. Reports & cash-up

### D-040 Which records belong to a period
- **Spec:** §4 Period, §6.11, §8.
- **Decision:** X/Z include exactly the sales of every kind whose `periodId` is the period's id. Every sale, deposit and refund takes the open period's id at commit, set by the data layer. Tabs count only when settled, through the settling sale. Void and noSale audit events carry `periodId` (D-083), and X/Z count them by periodId. Report functions never reprice; they only sum stored figures.
- **Example:** A sale in period 6 is refunded in period 7: the refund appears only in Z7. A tab opened in period 6 and settled in period 7 counts only in period 7.

### D-041 X and Z report figures
- **Spec:** §6.11, §7 cash-up formula and final paragraph.
- **Decision:** Let SL be the lines of kind `sale` sales, RL the lines of kind `refund` sales, and gross(l) = qty·unit.

  | Figure | Formula |
  |---|---|
  | grossSales | Σ_SL gross(l) |
  | dealDiscounts | Σ_SL dealDiscountPence |
  | memberDiscounts | Σ_SL memberDiscountPence |
  | refunds | negate(Σ_RL finalPence), a positive magnitude |
  | netTakings | grossSales − dealDiscounts − memberDiscounts − refunds (= Σ finals over SL ∪ RL) |
  | depositsTaken | Σ totalPence of kind `deposit` |
  | depositsApplied | Σ depositAppliedPence of kind `sale` |
  | cashTendered | Σ cash tenders on kinds `sale` + `deposit` |
  | changeGiven | Σ changePence |
  | cashRefunded | negate(Σ cash tenders on kind `refund`) |
  | cashTotal | cashTendered − changeGiven − cashRefunded |
  | cardTendered | Σ card tenders on `sale` + `deposit` |
  | cardRefunded | negate(Σ card tenders on `refund`) |
  | cardTotal | cardTendered − cardRefunded |
  | vatByRate | VAT summary over SL ∪ RL (refunds net off) |
  | float | period.floatPence |
  | expectedCash | float + cashTendered − changeGiven − cashRefunded |
  | noSaleCount / voidCount | D-043 |
  | declaredCash (Z only) | period.declaredCashPence |
  | variance (Z only) | declared − expected (negative = short, positive = over) |

  An X read is the same computation with the period still open. Display: deal discounts, member discounts and refunds print as negatives; everything else prints as its signed value. Net takings means product takings: it excludes deposits taken and includes goods paid for via deposits applied. Deposits applied appear in no cash term, so they don't change the drawer.

### D-042 Reconciliation identities (test assertions)
- **Spec:** §1.1, §6.11, §7, §10.1, §10.3 journey 7.
- **Decision:** Every X/Z computation satisfies these identities, and tests assert them:
  1. netTakings = Σ finals over SL ∪ RL.
  2. cashTotal + cardTotal = netTakings − depositsApplied + depositsTaken.
  3. expectedCash = float + cashTotal.
  4. Σ vatByRate.gross = netTakings, and net + vat = gross for each rate.
  5. grossSales − dealDiscounts − memberDiscounts = Σ_SL finals.
  6. For every sale, Σ tenders − change = total.

  For the same date range, product sales total takings = VAT report total gross.
- **Worked period:** float 10000.
  - S1 (member #1042): Lager ×3 @450 with "Lager 3 for 2", plus Crisps ×2 @125 at 0%. Total 977; cash 2000, change 1023.
  - S2: deposit 5000 for "Smith wedding", paid in cash.
  - S3: Wine ×4 @2295 with that booking (balance 5000). Applied 5000, total 4180; card 3000 + cash 1500, change 320.
  - S4: refund of 1 Lager from S1 by cash: −255 (VAT −43).
  - One no sale and two voids.

  Figures:
  - grossSales 10780; dealDiscounts 450; memberDiscounts 173; refunds 255; netTakings 9902.
  - depositsTaken 5000; depositsApplied 5000.
  - Cash: cashTendered 8500; changeGiven 1343; cashRefunded 255; cashTotal 6902.
  - Card: cardTendered 3000; cardRefunded 0; cardTotal 3000.
  - VAT 20%: gross 9690, VAT 1615, net 8075. VAT 0%: gross 212, VAT 0, net 212.
  - expectedCash = 10000 + 8500 − 1343 − 255 = 16902. Declared 16900 → variance −2.
  - noSaleCount 1; voidCount 2.

  Checks:
  - 6902 + 3000 = 9902 = 9902 − 5000 + 5000.
  - 16902 = 10000 + 6902.
  - 9690 + 212 = 9902.
  - 10780 − 450 − 173 = 10157 = 765 + 212 + 9180.

### D-043 Void and no-sale counts
- **Spec:** §3.2, §5, §6.3, §6.11.
- **Decision:** voidCount = the number of `void` audit events with that periodId, one per void action whatever the quantity. noSaleCount = the number of `noSale` events with that periodId. `override` events are not counted. Neither count affects any money figure.
- **Example:** A supervisor voids 2 of 3 Lagers, then a Crisps line: voidCount 2. A staff void approved by PIN writes one `override` and one `void` event: voidCount +1.

### D-044 Product sales report
- **Spec:** §6.11, §6.7.
- **Decision:** The range is Europe/London dates `[from, to]`, both inclusive (D-103). It includes kind `sale` and `refund` sales with `createdAt` in range; deposits have no lines.
  - **Product rows:** for each productId, qty = Σ line qty (refunds net off) and takings = Σ line finalPence. Takings are VAT-inclusive, after deal and member discounts, before any deposit applied, with refunds netted.
  - **Names:** a row uses the current product name, falling back to the most recent line's nameAtSale.
  - **Categories:** grouped by the product's current categoryId. A missing or deleted category groups as "Uncategorised", which sorts last. A category row is the sum of its products.
  - A product appears if it has any line in range, even if its net is 0.
  - **Sorting:** categories by sortOrder then name; products by sortOrder then name.
  - **Total:** total takings = VAT report total gross.
- **Example:** Over the D-042 scenario: Lager qty 2 (3 − 1), takings 510 (765 − 255); Crisps qty 2, 212; Wine qty 4, 9180. Total 9902.

### D-045 VAT report
- **Spec:** §6.11, §7.5.
- **Decision:** The range and sale selection are the same as D-044. It shows the VAT summary (D-021) over lines of kinds `sale` and `refund` (refunds net off), plus a totals row. Deposits are excluded because they have no lines.
- **Example:** D-042 scenario: 20% gross 9690, VAT 1615, net 8075; 0% gross 212, VAT 0, net 212. Totals: gross 9902, VAT 1615, net 8287.

### D-046 X read
- **Spec:** §6.11, §4 AuditEvent.
- **Decision:** An X read needs permission `xRead` and an open period. It computes the period's figures as of now and opens the X document. It writes nothing, except the `override` audit event when it was done via override. It consumes no receipt number.

### D-047 Z close
- **Spec:** §6.11, §8.
- **Decision:** A Z close needs permission `openClosePeriod`, requested when the "Z close" wizard starts; the Authorisation is held by the wizard and consumed by the confirm. It also needs an open period and an empty basket: no lines, member, booking or loaded tab. Otherwise the message is "Finish, park or void the current basket first".
  1. If open tabs exist, warn "N tabs are open and will carry over to the next period" with Continue and Cancel.
  2. Ask for the counted cash on the money keypad (0..9,999,999). The expected cash is not shown before this.
  3. Show expected, declared and variance with "Confirm Z close" and "Back".
  4. On confirm, one transaction:
     - `periods.close`: sets closedAt, closedBy, declaredCashPence and zNumber;
     - AuditEvent `zClose {zNumber, floatPence, expectedCashPence, declaredCashPence, variancePence}` with periodId = the closed period, plus `override` if applicable;
     - the outbox entries.

     Then the Z document opens.

  After the close, selling is disabled until a new period is opened. Past Z reports cannot be reprinted in v1.
- **Example:** Expected 50300, declared 50000 → variance −300 (short £3.00). The zClose detail is `{zNumber:7, floatPence:10000, expectedCashPence:50300, declaredCashPence:50000, variancePence:-300}`.

### D-128 The last report end date is 30/12/9999
- **Spec:** §6.11; refines D-103 with D-126's limit and message.
- **Decision:** The product sales and VAT reports reject a range they can't convert with `AppError('VALIDATION')` on field `toDate`. When both dates are valid and in order, the only cause is an end date of 31/12/9999, whose next day has no `YYYY-MM-DD` form, and the message is "End date must be 30/12/9999 or earlier", as for deals (D-126). Any other rejection (end before start, or a malformed date) keeps "Choose a valid date range: the end date must be on or after the start date".
- **Why:** A browser date input accepts year 9999, and telling the manager to move the end date after the start date when it already is would be wrong.
- **Example:** 26/09/2026–31/12/9999 → "End date must be 30/12/9999 or earlier". 31/12/9999–30/12/9999 → the end-before-start message.

## 10. Records & outbox

### D-048 Base fields on every record
- **Spec:** §3.2, §4, §11.
- **Decision:** Every synced record has `id` (`crypto.randomUUID()`), `deviceId` (Settings.deviceId of the creating device, never changed and preserved by import), `createdAt` and `updatedAt`. The data layer always generates all four. Create methods take `NewRecord<T>` (no base fields, no deletedAt) and return the stored record. Only backup import writes caller-supplied base fields. On create, createdAt = updatedAt = now. On update, only updatedAt changes. Append-only rows keep updatedAt = createdAt. `SaleLine`, `Tender`, `TabLine` and `SaleDealLine` are embedded value objects with no base fields. The only rows without base fields are the local OutboxEntry and Draft rows.

### D-049 Timestamps
- **Spec:** §3.2, §4, §11.
- **Decision:** Every instant is an ISO-8601 UTC string from `toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`, always 24 characters, so string comparison is chronological. `Booking.date` is a `LocalDate` (`YYYY-MM-DD`), not an instant. Each repository call reads the injected clock **once** and stamps every record and outbox entry it writes with that instant. Inside `transact()`, each nested call reads the clock once.
- **Example:** A sale committed at `2026-09-26T13:05:12.345Z` has that value as sale.createdAt, as every stock movement's createdAt, as settings.updatedAt and as each outbox createdAt.

### D-050 Optional fields are omitted; patch semantics
- **Spec:** §3.2, §4, §10.2.
- **Decision:** Optional fields (`?`) are omitted when absent. They are never stored as `null` and never as an undefined-valued key; the adapter strips undefined-valued keys before every write. The only stored null is `OutboxEntry.syncedAt`. Required text that may be blank (`Booking.notes`, `StockMovement.note`, `Settings.receiptFooter`) is stored as `''`. In `update(id, patch)`, a patch key whose value is `undefined` **removes** that field (for example, detaching a tab's member, or clearing a deal's end date).
- **Why:** Backup JSON round-trips exactly, and it avoids IndexedDB null-key quirks.
- **Example:** A cash sale with no member has no `memberId` key.

### D-051 Editable vs append-only; deactivate vs soft delete
- **Spec:** §3.2, §4, §6.5, §6.9, §11.
- **Decision:**
  - **Append-only (create and read only; no update or delete methods; adding an existing id fails):** Sale, StockMovement, AuditEvent.
  - **Editable (updatedAt bumps; optional deletedAt):** Staff, Category, Product, Deal, Member, Booking, Tab, Period, Settings.
  - **Active flag instead of deletion:** Staff, Member, Product and Deal use `active` (Deactivate/Reactivate) and are never deleted in the UI. Deactivated products are hidden from the grid and pickers; deactivated members can't be attached; deactivated staff can't log in or approve; deactivated deals don't apply.
  - **Soft delete (deletedAt):**
    - Category, which has no active flag, can be soft-deleted only when no non-deleted product references it.
    - A Tab is soft-deleted only when parked empty.
  - **Never deleted:** a Booking is cancelled through its status. Period, Settings and the append-only entities are never deleted.
  - **References keep working:** records that already reference an inactive or deleted item (tab lines, draft lines, deal productIds, historical sales) keep working.
  - **Queries:** `list()` excludes soft-deleted rows unless asked, and `get(id)` returns them.
  - **Hard deletes:** nothing is ever hard-deleted, except by backup import and the local Draft row.

### D-052 Embedded arrays
- **Spec:** §4, §11.
- **Decision:** `Sale.lines`, `Sale.tenders`, `Sale.dealLines`, `Tab.lines` and `Deal.productIds` are embedded in their parent record, with no child tables (they will map to jsonb columns later). Order matters for sale and tab lines (basket order) and for tenders (entry order).

### D-053 Outbox: what counts as a write
- **Spec:** §3.2, §10.2, §11.
- **Decision:** One write is one record created, updated or soft-deleted in a synced table. Each record write appends exactly one OutboxEntry in the same transaction, so a call that writes several records appends several entries. The synced tables are staff, categories, products, deals, members, bookings, tabs, sales, stockMovements, periods, auditEvents and settings. Not outboxed: the outbox itself, the draft table, and rows restored by backup import (the file's outbox is restored verbatim). Reads never write.
- **Example:** Settling a tab with 2 stock-tracked lines writes the sale, 2 stock movements, the settings counter update and the tab update: 5 entries. `products.create()` writes exactly 1: `{entity:'products', entityId, operation:'create', payload: <stored product>, syncedAt:null}`.

### D-054 Outbox entry shape
- **Spec:** §3.2, §11.
- **Decision:** An OutboxEntry is:
  - `seq`: auto-increment primary key (Dexie `++seq`), which defines push order;
  - `id`: a UUID;
  - `entity`: the table name;
  - `entityId`;
  - `operation`: `'create' | 'update' | 'delete'`;
  - `payload`: the full record exactly as stored after the write;
  - `createdAt`: the write instant;
  - `syncedAt`: null.

  `delete` is used exactly when the write sets deletedAt, and its payload still includes the whole record. Dexie 4.4.6 continues auto-increment above imported seq values.
- **Example:** Soft-deleting category C → `{seq:311, entity:'categories', entityId:C.id, operation:'delete', payload:{...C, deletedAt:'2026-09-26T15:00:00.000Z', updatedAt:'2026-09-26T15:00:00.000Z'}, createdAt:'2026-09-26T15:00:00.000Z', syncedAt:null}`.

### D-055 Data-model additions beyond spec §4
- **Spec:** §4.
- **Decision:**
  - `Sale.dealLines: SaleDealLine[]` (`[]` on deposits and refunds).
  - `SaleLine.refundOfLineIndex?` and `SaleLine.returnToStock?` (refund lines only).
  - `AuditEvent.periodId?` (D-083).
  - A typed `AuditEvent.detail` per type (D-084).
  - `Draft` table (D-094).
  - Deal `startsAt`/`endsAt` are instants (D-012).

  Line net is never stored. Basket, tab and draft lines are `{productId, qty}` (D-008).

### D-056 Transactions
- **Spec:** §3.2, §8, §10.2.
- **Decision:** `Repos.commitSale` is the single sale transaction for kinds sale, deposit and refund. In order, it:
  1. Looks up the open period (else `NO_OPEN_PERIOD`).
  2. Re-checks the facts that must be transactional: tab open; booking open; deposit applied ≤ balance; refund quantities available; original is kind `sale`.
  3. Allocates the receipt number (D-059).
  4. Adds the sale.
  5. Adds the stock movements computed by the services.
  6. Settles the tab.
  7. Clears the draft if asked.
  8. Writes the outbox entries.

  `Repos.transact(work)` runs `work` in one read-write transaction over every table; every repository call inside joins it, and a throw rolls everything back. Services use it to write audit events together with their action (refund + audit, product + priceChange, void events, tab + draft clear, Z close + zClose event, sample data). **Constraint:** `work` may await only repository calls; PIN hashing and any other async work happen before.
- **Why:** "Nothing partial is ever written" (§8), with one generic mechanism instead of a bespoke operation per flow.

## 11. Settings & numbering

### D-057 Settings singleton and defaults
- **Spec:** §4 Settings, §6.1.
- **Decision:** Each device database holds exactly one Settings row, with `id === deviceId` (a UUID). `Repos.initialise` creates it in the same transaction as the first manager, not at app boot. Defaults:
  - clubName: as entered at setup;
  - receiptFooter: `'Thank you for your custom'`;
  - autoLockMinutes: 5;
  - memberDiscountPercent: 15;
  - lastBackupAt: omitted;
  - deviceId: `newId()`;
  - devicePrefix: the first 4 characters of deviceId, upper-cased;
  - receiptCounter: 0.

  Managers can edit clubName, receiptFooter, autoLockMinutes (1..60), memberDiscountPercent and devicePrefix. deviceId and receiptCounter are never user-editable. lastBackupAt is set only by export, or restored by import. Writes before initialise throw `NOT_INITIALISED`.
- **Example:** deviceId `3f9c2a1e-7b4d-4e8a-9c1f-5a6b7c8d9e0f` → `devicePrefix '3F9C'`.

### D-058 devicePrefix
- **Spec:** §4, §11.
- **Decision:** devicePrefix must match `/^[A-Z0-9]{1,6}$/`. No hyphen is allowed, because `-` separates the prefix from the number. The input is upper-cased before validation. Changing it does not reset receiptCounter.
- **Example:** Changing the prefix from `3F9C` to `BAR1` when the counter is 57 → the next receipt is `BAR1-000058`.

### D-059 Receipt number allocation
- **Spec:** §4, §8, §10.2.
- **Decision:** Inside `commitSale`: next = receiptCounter + 1; receiptNumber = `` `${devicePrefix}-${String(next).padStart(6,'0')}` ``; receiptCounter = next (one `update` outbox entry). It is atomic with the sale, so a failed commit consumes no number. `receiptNumber` has a unique index. Past 999999 the number grows longer; it never wraps or truncates.
- **Example:** Prefix `3F9C` with counter 41 → the sale gets `3F9C-000042` and the counter becomes 42.

### D-060 Which documents take receipt numbers
- **Spec:** §4, §6.7, §6.8, §6.10.
- **Decision:** Every Sale record takes exactly one number, whether kind sale, deposit or refund. A refund gets a new number and references the original through `refundOfSaleId`. X reads, Z reports and no sales take none. A Z report is identified by its zNumber, and a no sale prints nothing.
- **Example:** Sale `3F9C-000042`, deposit `3F9C-000043`, refund of 000042 → `3F9C-000044`.

### D-061 Z numbers
- **Spec:** §4 Period, §6.11.
- **Decision:** There is no counter field. In the Z-close transaction, zNumber = 1 + the maximum zNumber among Period rows with `deviceId === Settings.deviceId`, or 1 if there are none.
- **Example:** Closed periods have zNumbers 1..6, so the next Z close assigns 7.

## 12. Tabs

### D-062 Tab lines and repricing
- **Spec:** §4 Tab, §6.6, §7.
- **Decision:** A TabLine is `{productId, qty}` with no price snapshot. A tab is always priced by `priceBasket` using current product prices, the deals in force now, `settings.memberDiscountPercent` if the tab has a member, and no booking. This applies to the total on the Tabs screen and, via Pay, at settlement. Deals are evaluated across all of the tab's lines at settlement, not per round. Stock moves only at settlement.
- **Example:** Round 1 is Lager ×2 and round 2 is Lager ×1. With a Lager 3 for 2 at settlement, one group of 3 saves 450: the total is 900.

### D-063 Tab operations
- **Spec:** §6.6, §5.
- **Decision:** Every tab operation needs permission `tabs` and an open period.
  - **(a) New tab:** the basket has lines, is not in tab mode and has no booking. Choose labelType and label. This creates `Tab {labelType, label, openedAt: now, openedBy: current staff, status:'open', lines: basket lines, memberId?}` and clears the basket and draft in the same transaction.
  - **(b) Add basket to an open tab:** same preconditions as (a).
    - `mergeLines`: existing productIds are summed in place and new ones are appended in basket order. A merged qty above 999 is rejected.
    - If the tab has no member and the basket has one, the tab takes it; otherwise the tab keeps its own.
    - The basket and draft are cleared.
  - **(c) Load (reopen):** only into a completely empty basket. It sets `basket = {lines: tab.lines, memberId: tab.memberId, tabId}`, which is "tab mode". Nothing is written to the tab; the Tabs list marks it "On till".
  - **(d) Park ("Save to tab"):** only in tab mode with no booking. It writes `tab.lines` = basket lines and `tab.memberId` = the basket member (the key is removed if the member was detached), then clears the basket and draft. With no lines left, the tab is soft-deleted instead.
  - **(e) Settle:** press Pay in tab mode. The sale commits with `tabId`, and the same transaction sets `tab.status = 'settled'` and `tab.lines` = the settled lines.

  In tab mode you cannot create, add to or load another tab. The per-tab "Settle" button on the Tabs screen does (c) and then opens Pay. Voids of loaded tab lines are normal voids (D-085) with `tabId` in the detail.
- **Example:** Sell 2 × Fairway Lager and choose New tab, Name "Smith". Sell 1 × Ready Salted Crisps and add it to "Smith": the lines become `[Fairway Lager ×2, Ready Salted Crisps ×1]`. Settle → Pay → `sale.tabId = Smith.id`, and the tab's status becomes `settled`.

### D-064 Tab labels, list and time open
- **Spec:** §4 Tab, §6.6.
- **Decision:** Labels are trimmed with internal whitespace collapsed.
  - **Name labels:** 1..30 characters.
  - **Table labels:** 1..10 letters, digits, spaces or hyphens, displayed as `Table {label}`.
  - **Uniqueness:** among open, non-deleted tabs, the pair (labelType, case-insensitive label) must be unique. A label can be reused once its tab is settled or deleted.
  - **Tabs screen:** lists open, non-deleted tabs by openedAt ascending, each with its display label, repriced total and time open (`Xh Ym`, or `Ym` under an hour).
- **Example:** With a name tab "Smith" open, `'smith '` is rejected as a name tab. A table tab "5" and a name tab "5" can coexist.

### D-065 Tabs, members and bookings
- **Spec:** §6.6, §6.7.
- **Decision:** A tab's memberId is set when it is created (from the basket), by add-to-tab when the tab has none, and by parking. When the tab is settled, `sale.memberId` is the basket's member, which is the tab's member (§6.6). Bookings are never stored on tabs: New tab, Add to tab and Park are disabled while a booking is attached. To use a deposit against a tab, load the tab, attach the booking, then Pay.

### D-066 Tabs spanning periods
- **Spec:** §6.11, §8.
- **Decision:** Z close leaves open tabs untouched. The settling sale takes the period open at settlement. Nothing about the tab counts in the period in which it was opened.

## 13. Periods

### D-067 Opening a period
- **Spec:** §4 Period, §5, §6.3, §8.
- **Decision:** The open period is the Period with `deviceId === Settings.deviceId` and no closedAt; at most one may exist. `periods.open` checks this inside its transaction (`PERIOD_ALREADY_OPEN`). It needs permission `openClosePeriod` and a float of 0..9,999,999 entered on the money keypad, and it creates `Period {openedAt, openedBy, floatPence}`. There is no audit type for opening; an `override` event is written only if the action was overridden. With no open period, the till shows "No trading period open" and an "Open period" button: managers act directly and anyone else gets the override dialog.

### D-068 What needs an open period
- **Spec:** §6.3, §8.
- **Decision:**
  - **Requires an open period:** adding items to the basket; attaching a member or booking; every tab operation; Pay/commit of any Sale kind (sale, deposit, refund); void; no sale; X read; Z close.
  - **Allowed without one:** login and lock; viewing the Tabs and Bookings lists; creating, editing, settling and cancelling bookings; member, product, category, deal, staff and settings management; goods in and stock adjustments; product sales and VAT reports; backup export and import.

## 14. Permissions & PINs

### D-069 Action identifiers and `can()`
- **Spec:** §5, §10.1.
- **Decision:** `Action` has one identifier per §5 row, with these minimum roles:

  | Action | Minimum role |
  |---|---|
  | `sell` | staff |
  | `tabs` | staff |
  | `attachMember` | staff |
  | `bookings` | staff |
  | `voidLine` | supervisor |
  | `noSale` | supervisor |
  | `xRead` | supervisor |
  | `refund` | manager |
  | `openClosePeriod` | manager |
  | `editCatalogue` | manager |
  | `stockControl` | manager |
  | `manageMembersStaffSettings` | manager |
  | `salesReports` | manager |
  | `backup` | manager |

  `ROLE_RANK = {staff:0, supervisor:1, manager:2}`; `can(role, action) = ROLE_RANK[role] ≥ ROLE_RANK[MIN_ROLE[action]]`. `Role` and `Action` are defined in `src/data/types.ts`, because they are persisted, and re-exported by `rules/permissions.ts`.

  Scopes:
  - `attachMember` includes detaching.
  - `bookings` covers create, edit, take deposit, attach, detach, settle and cancel.
  - `tabs` covers new, add, load, park and settle.
  - `stockControl` covers goods in, adjustment and manual waste.
  - `editCatalogue` covers products, categories (including delete), deals and prices.
  - `manageMembersStaffSettings` covers members, staff (including PIN reset) and settings.
  - `salesReports` covers the product sales and VAT reports.
  - `backup` covers export and import.
- **Example:** can('staff','voidLine') = false; can('supervisor','voidLine') = true; can('supervisor','refund') = false; can('manager','backup') = true.

### D-070 Where the check happens
- **Spec:** §5, §6.3.
- **Decision:**
  - **What is gated:** actions, at the moment they are performed, on the button that writes data or produces a document. These are:
    - Void, No sale and X read;
    - the Refund commit, Open period and the Z close wizard start (D-047);
    - Save on any back-office form, and the goods-in and adjustment submits;
    - Run report, Export and Import;
    - Pay/commit (`sell`), and booking and tab actions, which always pass for every role.
  - **How:** everything goes through one UI helper, `requirePermission(action)`, which returns an `Authorisation` or null if cancelled.
  - **Navigation:** never gated. Every role can open every screen and read lists, but report figures appear only after Run. The Void and No sale buttons are visible to all roles.
  - **No override needed:** if `can(currentRole, action)` is true, the action proceeds with no dialog and no override event.
- **Why:** One uniform rule, and it stays safe even if a lower-level user lands on a manager screen after an auto-lock.

### D-071 Override flow
- **Spec:** §5.
- **Decision:** When `can` is false, a modal asks for a "Supervisor or manager PIN" (minimum role supervisor) or a "Manager PIN" (minimum role manager). The PIN is matched against active, non-deleted staff, and approval succeeds iff the matched approver satisfies `can(approver.role, action)`. The resulting `Authorisation {action, staffId: requester, approvedById}` is single-use: it is passed to exactly one service call and then dropped. Repeating the action needs a new approval. Cancel aborts the action, and an auto-lock while the dialog is open cancels it.

### D-072 Override audit and actor fields
- **Spec:** §5, §4 AuditEvent.
- **Decision:** An approved override writes `AuditEvent {type:'override', staffId: requester, approvedById: approver, detail:{action}, periodId?}` in the same transaction as the action's own writes. For read-only actions (X read, report run) it is written on its own when the document or report is produced. The action's own records keep the logged-in user as the actor: Sale.staffId, Period.openedBy/closedBy, Tab.openedBy and StockMovement.staffId. If the action has its own audit type (void, noSale, refund, priceChange, stockAdjust, zClose, backupExport, backupImport), that event also carries `staffId = requester` and `approvedById = approver`. Without an override, approvedById is omitted.
- **Example:** Sam Staff voids 1 × Club Bitter, approved by Sue Supervisor. One transaction writes `{type:'override', staffId:sam, approvedById:sue, detail:{action:'voidLine'}}` and `{type:'void', staffId:sam, approvedById:sue, detail:{productId, productName:'Club Bitter', qty:1, unitPricePence:420}}`.

### D-073 PIN format and hashing
- **Spec:** §2, §4 Staff.
- **Decision:** A PIN matches `/^\d{4,6}$/`. It is entered on a keypad with an explicit Enter key (no auto-submit); physical digits, Backspace and Enter also work.
  - **Hashing:** salt = 16 bytes from `crypto.getRandomValues`. PBKDF2-SHA-256 with 100,000 iterations (`PIN_ITERATIONS`) derives 256 bits.
  - **Storage:** `pinSalt` = 32-char lowercase hex; `pinHash` = 64-char lowercase hex.
  - **Isolation:** `src/services/pin.ts` is pure and async. Hashes never enter UI state, logs or the screen.
  - **New PINs:** always entered twice.
  - **Transactions:** hashing never runs inside `transact()`.
- **Why:** About 75 ms per derivation on Node 22, so logging in with ~3 staff stays fast. The iteration count must be raised before any real use.

### D-074 PIN compare and login
- **Spec:** §2, §6.2.
- **Decision:** `verifyPin` derives with the stored salt and compares all 32 bytes with an XOR accumulator, with no early exit.
  - **Login:** a malformed PIN is rejected without hashing. Otherwise the active, non-deleted staff are checked in order of createdAt, then id, and the first match logs in.
  - **Session:** `{staffId, name, role}` lives only in memory (Zustand), so a refresh always returns to the login screen.

### D-075 PIN uniqueness
- **Spec:** §2, §6.2.
- **Decision:** A PIN must be unique among active, non-deleted staff. Uniqueness is checked by verifying the candidate against every other active, non-deleted staff member's hash when a staff member is created or a PIN is reset. Reactivating a deactivated staff member requires a new PIN in the same save. On a clash the error is `PIN_UNAVAILABLE`, "That PIN can't be used — choose another", without naming the owner.

### D-076 Failed PIN attempts
- **Spec:** §2, §5, §6.2.
- **Decision:** Login and override share one in-memory count of consecutive failures (`rules/lockout.ts`). After 5 failures the keypad is disabled for 30 seconds with a countdown, and the count restarts. Any success resets it; a refresh also resets it (accepted for a learning build). Messages: login shows "PIN not recognised"; override shows "PIN not accepted", whatever the reason. Failed attempts are not audited, and the entered PIN is cleared after each attempt.

### D-077 Staff: last manager and self-changes
- **Spec:** §5, §6.9.
- **Decision:** A staff save is rejected (`LAST_MANAGER`) if, afterwards, no active, non-deleted staff member would have role `manager`. A logged-in user cannot change their own role or deactivate themselves, but can change their own name and PIN. Staff are never deleted; they are deactivated. Staff names need not be unique (1..40 chars).

### D-078 Auto-lock
- **Spec:** §6.2, §4 Settings.
- **Decision:**
  - **Activity:** a `pointerdown` or `keydown` on document (capture phase) sets `lastActivity = Date.now()`.
  - **Timer:** a 1-second interval, running only while someone is logged in, locks when `Date.now() − lastActivity ≥ autoLockMinutes × 60000`. Changes to autoLockMinutes apply immediately.
  - **What a lock does:** it logs out. The session is cleared and the login keypad shows.
  - **What survives:** the in-memory basket (lines, member, booking, loaded tab), the Pay session (D-033) and the draft.
  - **What is discarded:** open dialogs, including override dialogs, and unsaved form input.
  - **Manual lock:** a Lock button does the same.
  - **After login:** the app goes to Pay if a Pay session exists, else the Till. The next sale is recorded under whoever completes it.

### D-127 Checks made before a slow step are settled inside the write transaction
- **Spec:** §6.1, §8; refines D-056, D-073, D-075, D-111 and D-124.
- **Decision:** PIN hashing (D-073) and other non-repository work must happen before `transact()` (D-056), so a check made then can be out of date by the time the write runs; a double-tapped Save is enough. Every such check is therefore settled inside the write's transaction:
  - **First run:** `completeFirstRun` checks for staff early (a fast answer before hashing), then again inside the same `transact()` as `repos.initialise`. If any staff row exists by then it fails with `CONFLICT` "The till has already been set up" and writes nothing, so it never adds a second manager or reaches `loadSampleData`.
  - **Staff PINs:** the D-075 uniqueness check records the credentials (`pinSalt`, `pinHash`) of every active, non-deleted staff member it verified against. `createStaff`, and `updateStaff` with a new PIN, re-list the staff inside their transaction. If any active, non-deleted member other than the one being saved is not in that record, or has different credentials, the save fails with `CONFLICT` "Staff changed while saving — try again" and writes nothing. The new PIN can't be re-verified inside the transaction, so this is deliberately conservative: saving again gives the real answer (`PIN_UNAVAILABLE` or success). Changes to other staff's names, roles or active flags alone never cause it.
  - **Refunds:** `commitRefund` reads the original's earlier refunds and builds the refund (`buildRefundSale` → `validateSale` → stock movements) inside the commit transaction, because the cumulative shares (D-037, D-125) depend on them. Two overlapping refunds of one line are then priced as consecutive slices, and the line's refunds still sum to exactly the negated original.
- **Why:** D-113 supports one tab, but one tab can still start two saves before the first finishes. Two active staff with one PIN would make the second person log in as the first (D-074), recording their sales against the wrong staffId.
- **Example:** Two overlapping `createStaff({name:'Sam', pin:'5555'})` calls: one is saved and the other fails with `CONFLICT`; saving it again fails with `PIN_UNAVAILABLE`. Two overlapping refunds of 1 Lager from S1 (D-037) store VAT −43 and −42, not −43 twice.

## 15. Stock

### D-079 Sale stock movements
- **Spec:** §3.2, §4 StockMovement, §6.4, §8.
- **Decision:** On sale commit, each line whose product has `stockTracked === true` **at commit time** gets `{productId, qty: −line.qty, reason:'sale', saleId, staffId: sale.staffId, note:''}`. The services compute these with `rules/stock.stockMovementsForSale` and `commitSale` writes them. Deposits and untracked products write none. Toggling stockTracked never rewrites history. Selling is never blocked by the stock level, and no warning is shown at sale time.

### D-080 Goods in
- **Spec:** §6.9.
- **Decision:** Goods in needs permission `stockControl`. The picker lists non-deleted, stockTracked products. qty is an integer 1..9999, with an optional note of 0..100 characters. It writes `StockMovement {reason:'goodsIn', qty:+qty, staffId, note}` and no audit event.

### D-081 Adjustment and manual waste
- **Spec:** §6.9, §4.
- **Decision:** The form has product (non-deleted, stockTracked), type (`adjustment` or `waste`), qty and a required note (1..100 chars, the "reason" in §6.9). An adjustment qty is a signed, non-zero integer −9999..9999, stored as entered. For waste the manager enters a positive count 1..9999, stored as negative. Both write the movement and `AuditEvent stockAdjust {stockMovementId, productId, productName, qty (signed), reason, note}` in one transaction. There is no "set count to N" stock-take in v1.
- **Example:** Waste 2 × Club Bitter with note "Spilt" → a movement with qty −2 and reason `waste`; the stockAdjust detail has `qty:-2, reason:'waste', note:'Spilt'`.

### D-082 On hand and the low-stock list
- **Spec:** §3.2, §6.9, §8.
- **Decision:** onHand(product) = Σ qty of its movements. It is an integer, may be negative, and is shown only for stockTracked products. The low-stock list (`StockMovementRepo.lowStock()`) holds products that are stockTracked, active and not deleted with onHand ≤ lowStockLevel, so negative stock always appears. It is sorted by (onHand − lowStockLevel) ascending, then name, then id. lowStockLevel is an integer 0..9999, and 0 for untracked products.
- **Example:** Single Malt Whisky with starting stock 10 and low level 14 is listed. Club Bitter at −2 with low level 22 is listed first.

## 16. Audit

### D-083 periodId on audit events
- **Spec:** §4 AuditEvent, §6.11.
- **Decision:** `AuditEvent.periodId?` is the id of the period the action belongs to: normally the open period when the event is written. For zClose and its override it is the period being closed; for an open-period override it is the new period. It is omitted when no period is open. Reports count voids and no sales by periodId, not by time window.

### D-084 Audit detail shapes
- **Spec:** §4 AuditEvent.
- **Decision:** `detail` is typed per `type` (`AuditDetailByType` in types.ts):

  | Type | Detail |
  |---|---|
  | `void` | `{productId, productName, qty (units removed, >0), unitPricePence (current), tabId?}` |
  | `noSale` | `{}` |
  | `refund` | `{refundSaleId, refundReceiptNumber, originalSaleId, originalReceiptNumber, totalPence (≤0), tender, lines: {productId, qty (positive), returnToStock}[]}` |
  | `priceChange` | `{productId, productName, oldPricePence, newPricePence}` |
  | `override` | `{action}` |
  | `stockAdjust` | `{stockMovementId, productId, productName, qty (signed), reason: 'adjustment' \| 'waste', note}` |
  | `zClose` | `{zNumber, floatPence, expectedCashPence, declaredCashPence, variancePence}` |
  | `backupExport` | `{exportedAt}` |
  | `backupImport` | `{fileExportedAt, fileDeviceId, importedByName}` |

  Not audited: failed PINs, logins, X reads without an override, goods in, opening a period (other than its override) and ordinary record edits.

### D-085 Voids
- **Spec:** §3.2, §5, §6.3, §6.11.
- **Decision:** A void is any reduction of a basket line's quantity, including removing the line, and including lines loaded from a tab. Adding is never a void. The Void action asks for the quantity to remove: 1..line qty, default the whole line. Each void needs permission `voidLine` and an open period. It writes exactly one `void` event (plus `override` if applicable) in one transaction, and the basket changes only after that commit. There is no "clear basket" or "void all". Detaching a member or booking, moving the basket to a tab and cancelling a payment are not voids.
- **Example:** Fairway Lager ×3 reduced to ×1 → one void event with qty 2 and unitPricePence 480.

### D-086 No sale
- **Spec:** §5, §6.3, §6.11.
- **Decision:** A no sale needs permission `noSale` and an open period. It writes `AuditEvent {type:'noSale', detail:{}, periodId}` (plus `override` if applicable) and shows a "Drawer opened" toast. It prints nothing and takes no receipt number.

### D-087 Price change audit
- **Spec:** §4 AuditEvent, §6.9.
- **Decision:** When a product save changes `pricePence`, the same transaction writes `priceChange {productId, productName (after the save), oldPricePence, newPricePence}` (plus `override` if applicable). Creating a product, changing other fields (including vatRate) and editing deal prices write no priceChange.
- **Example:** Club Bitter 420 → 440 writes `{productName:'Club Bitter', oldPricePence:420, newPricePence:440}`.

## 17. Backup

### D-088 Backup file format
- **Spec:** §1.2, §3.1, §8, §10.2.
- **Decision:** One JSON file (`JSON.stringify(file, null, 2)`) named `club-epos-backup-YYYY-MM-DD-HHmm.json` in London time. It contains `{format:'club-epos-backup', version: SCHEMA_VERSION (1), exportedAt, deviceId, tables: {staff, categories, products, deals, members, bookings, tabs, sales, stockMovements, periods, auditEvents, settings, outbox}}`. Every row is included exactly as stored, including soft-deleted rows, PIN hashes and the outbox rows with their seq. The draft is excluded. The export screen warns that the file contains PIN hashes and all takings.

### D-089 Backup validation
- **Spec:** §8.
- **Decision:** Before any confirmation, the whole file is rejected, listing up to 10 problems, if any of these hold:
  - it is larger than 50 MB;
  - JSON.parse fails, or the top level is not an object;
  - format ≠ `club-epos-backup`;
  - version ≠ SCHEMA_VERSION ("This backup was made by a different version");
  - exportedAt is not a valid ISO instant;
  - `tables` lacks any of the 13 keys, has extra keys or has a non-array value;
  - any row has a missing required field, an unknown field, or a wrong primitive type or enum value (money and qty fields must be integers, ids UUID v4 strings, timestamps ISO strings);
  - a table has duplicate ids (for the outbox, duplicate seq or id);
  - settings has other than exactly one row;
  - there is no active, non-deleted manager.

  No other referential checks are made.

### D-090 Backup import
- **Spec:** §8, §5.
- **Decision:**
  - **Before import:** the screen shows exportedAt, the file's devicePrefix (with a warning when its deviceId differs from this device's) and the row counts. Import is enabled only when the user types `REPLACE` exactly. Permission `backup` is checked when Import is pressed.
  - **`importAll`, one transaction:**
    1. Clear all 13 tables and the draft.
    2. `bulkAdd` every file row verbatim; no outbox entries are generated, and the file's outbox is restored as-is.
    3. Append `[override?, backupImport]`, each with its outbox entry. These use `staffId` = the importer's id from before the import, and periodId = the imported open period, if any.
  - **Identity:** Settings (deviceId, devicePrefix, receiptCounter, lastBackupAt) come from the file, so an import restores that till's identity and numbering.
  - **Afterwards:** the session ends, the in-memory basket is cleared and the login screen shows.

### D-091 Backup export and lastBackupAt
- **Spec:** §4 Settings, §8.
- **Decision:** Export needs permission `backup`. First, one transaction sets `Settings.lastBackupAt = now` and appends `backupExport {exportedAt: now}` (plus `override` if applicable). Then `exportAll()` builds the file with `exportedAt` = that same now, so the file contains its own export event and the updated lastBackupAt. The download uses a Blob and an `<a download>` click. The app cannot detect a cancelled download and does not try.

### D-092 Repository-level round trip
- **Spec:** §10.2.
- **Decision:** `exportAll()` and `importAll(tables, {auditEvents?})` have no side effects beyond the data itself: no generated outbox entries and no lastBackupAt change. The contract test takes `exportAll()` from DB A, runs `importAll()` into a fresh DB B with no audit events, then checks that `exportAll()` from B `toEqual`s the first export.

### D-093 Seven-day backup reminder
- **Spec:** §8.
- **Decision:** Logged-in managers (by their own role, not via override) see a non-blocking, in-flow banner "No backup in the last 7 days — Back up now" when `now − (lastBackupAt ?? settings.createdAt) ≥ 604,800,000 ms`. It can be dismissed for the current login only.
- **Example:** lastBackupAt `2026-09-19T10:00:00.000Z` and now `2026-09-26T10:00:00.000Z` is exactly 7 days, so the banner shows.

## 18. Draft basket

### D-094 Draft storage
- **Spec:** §6.2, §8, §3.2.
- **Decision:** A device-local Dexie table `draft` holds at most one row with key `id:'current'`, accessed only through `DraftRepo` (get, save, clear). It is not synced: no base fields except updatedAt, no outbox entries, excluded from backups and cleared by import. There is one draft per device, not per staff member. The app uses no localStorage or sessionStorage.
- **Why:** Because the draft is in IndexedDB, the sale commit can delete it in the same transaction, so a paid basket can never be restored and sold twice.

### D-095 Draft contents and lifecycle
- **Spec:** §6.2, §8, §10.3.8.
- **Decision:** A draft is `{id:'current', lines:{productId, qty}[], memberId?, bookingId?, tabId?, updatedAt}`.
  - **Saving:** it is saved after every basket change, with no debounce: add, void, member or booking attach/detach, and tab load.
  - **Deleting:** when the basket is completely empty, the row is deleted.
  - **What it excludes:** Pay tenders.
  - **Atomic clears:** kind `sale` commits delete it inside `commitSale`; new tab, add-to-tab and park delete it in their own transactions. Deposit and refund commits never touch it.

### D-096 Draft restore
- **Spec:** §6.2, §8, §10.3.8.
- **Decision:** At every successful login, if the in-memory basket is empty (for example after a refresh), the draft is loaded for whoever logged in. Stale references are handled like this:
  - If `tabId` is set and the tab is missing, deleted or not `open`, the whole draft is discarded.
  - Otherwise, lines whose product record no longer exists are dropped. Inactive or deleted products are kept, because they still price.
  - A missing member is dropped.
  - A booking that is missing, not `open`, or has a zero balance is dropped.

  If anything was removed, a toast says "N item(s) removed from the saved basket". Through an auto-lock the in-memory basket is kept and the draft is not re-read.

## 19. Sample data

### D-097 Sample catalogue
- **Spec:** §9.
- **Decision:** Seven categories, each listed with (sortOrder, colour):
  - Draught (1, #b45309)
  - Bottles & Cans (2, #a16207)
  - Spirits (3, #7c3aed)
  - Wine (4, #9f1239)
  - Soft Drinks (5, #0369a1)
  - Snacks (6, #15803d)
  - Events (7, #475569)

  Exactly 40 products, all active. Each product's sortOrder is its 1-based position within its category, and its buttonColour is the category colour.

  **Draught** (20%, member-eligible):

  | Product | Price | Unit | Tracked | Starting stock | Low level |
  |---|---|---|---|---|---|
  | Club Bitter | 420 | pint | yes | 88 | 22 |
  | Fairway Lager | 480 | pint | yes | 88 | 22 |
  | Links IPA | 520 | pint | yes | 88 | 22 |
  | Old Caddie Stout | 500 | pint | yes | 88 | 22 |
  | Orchard Cider | 460 | pint | yes | 88 | 22 |
  | Shandy | 380 | pint | no | — | 0 |

  **Bottles & Cans** (20%, eligible, tracked, starting stock 48, low 12):

  | Product | Price | Unit |
  |---|---|---|
  | Birdie Pale Ale | 450 | bottle |
  | Bogey Brown Ale | 450 | bottle |
  | Albatross Lager | 430 | bottle |
  | Eagle Cider | 470 | bottle |
  | Clubhouse Stout | 400 | can |
  | Zero Lager (alcohol-free) | 350 | bottle |

  **Spirits** (20%, eligible, tracked, unit `measure`, low 14, starting stock 56 unless shown):

  | Product | Price | Starting stock |
  |---|---|---|
  | House Gin | 380 | 56 |
  | House Vodka | 360 | 56 |
  | House Whisky | 400 | 56 |
  | Single Malt Whisky | 550 | **10** (so the low-stock list is non-empty) |
  | Dark Rum | 380 | 56 |
  | Brandy | 420 | 56 |

  **Wine** (20%, eligible, tracked):

  | Product | Price | Unit | Starting stock | Low level |
  |---|---|---|---|---|
  | House Red (175ml) | 550 | glass | 40 | 10 |
  | House White (175ml) | 550 | glass | 40 | 10 |
  | House Rosé (175ml) | 550 | glass | 40 | 10 |
  | House Red (bottle) | 1900 | bottle | 12 | 3 |
  | House White (bottle) | 1900 | bottle | 12 | 3 |
  | Prosecco (bottle) | 2600 | bottle | 12 | 3 |

  **Soft Drinks** (20%, eligible):

  | Product | Price | Unit | Tracked | Starting stock | Low level |
  |---|---|---|---|---|---|
  | Cola | 250 | glass | no | — | 0 |
  | Lemonade | 250 | glass | no | — | 0 |
  | Orange Juice | 280 | bottle | yes | 24 | 6 |
  | Sparkling Water | 220 | bottle | yes | 24 | 6 |
  | Still Water | 200 | bottle | yes | 24 | 6 |
  | Apple & Mango Fizz | 300 | bottle | yes | 24 | 6 |
  | Tonic Water | 150 | bottle | yes | 24 | 6 |

  **Snacks** (20%, eligible, tracked, starting stock 36, low 8):

  | Product | Price | Unit |
  |---|---|---|
  | Ready Salted Crisps | 120 | packet |
  | Salt & Vinegar Crisps | 120 | packet |
  | Cheese & Onion Crisps | 120 | packet |
  | Dry Roasted Peanuts | 150 | packet |
  | Pork Scratchings | 150 | packet |
  | Chocolate Bar | 140 | bar |

  **Events** (not member-eligible, not tracked, low 0):

  | Product | Price | VAT | Unit |
  |---|---|---|---|
  | Raffle Ticket | 100 | **0%** | ticket |
  | Sweepstake Entry | 200 | **0%** | entry |
  | Buffet Ticket | 1500 | 20% | ticket |

  The 0% products are Raffle Ticket and Sweepstake Entry.

### D-098 Sample deals
- **Spec:** §9, §7.2.
- **Decision:**
  - "Any 2 bottles for £8": nForPrice, n 2, pricePence 800, on Birdie Pale Ale, Bogey Brown Ale, Albatross Lager, Eagle Cider and Clubhouse Stout. Zero Lager is excluded, because 350 + 400 < 800 would never save.
  - "Snacks 3 for 2": nForM, n 3, m 2, on Ready Salted, Salt & Vinegar and Cheese & Onion Crisps, Dry Roasted Peanuts and Pork Scratchings. Chocolate Bar is excluded.

  Both deals are active with no dates, and no product is in both.
- **Examples (usable by e2e):**
  - 2 × Birdie Pale Ale: deal 100 (50/50), final 800. With a member: 800 × 15% = 120, total 680, VAT 113.
  - 2 × Birdie Pale Ale + 1 × Fairway Lager with a member: postDeal 800 and 480, base 1280, discount 192 (shares 120 and 72). Finals 680 and 408 (VAT 113 and 68), total 1088. Card £5 plus cash £10 gives change 412.
  - 3 × Ready Salted Crisps + 1 × Chocolate Bar, no member: deal 120 (40 per packet), total 240 + 140 = 380.

### D-099 Sample staff PINs and e2e conventions
- **Spec:** §9, §2, §10.3.
- **Decision:** The sample data adds "Sam Staff" (role staff, **PIN 1111**) and "Sue Supervisor" (role supervisor, **PIN 2222**), both active. When "Load sample data" is ticked, the setup manager's PIN may not be 1111 or 2222; the error is "That PIN is used by the sample staff". Recommended e2e convention: club "Oakfield Golf Club", manager "Morgan Manager", **PIN 1234**.
- **Example:** Journey 5: log in with 1111 → Void → override dialog → 2222 → approved.

### D-100 Sample members, bookings and opening stock
- **Spec:** §9.
- **Decision:** There are 20 active members, numbered 1001–1020:

  | Number | Name | Number | Name |
  |---|---|---|---|
  | 1001 | Alice Archer | 1011 | Katie Kerr |
  | 1002 | Ben Birch | 1012 | Liam Lockhart |
  | 1003 | Clara Chalmers | 1013 | Megan Moss |
  | 1004 | David Dunmore | 1014 | Noah Newland |
  | 1005 | Emma Ellis | 1015 | Olivia Orr |
  | 1006 | Frank Fairley | 1016 | Peter Pryce |
  | 1007 | Grace Gilmour | 1017 | Quinn Quayle |
  | 1008 | Harry Hollis | 1018 | Rosa Rennie |
  | 1009 | Isla Irving | 1019 | Sophie Sutherland |
  | 1010 | Jack Jennings | 1020 | Tara Thornton |

  Two open bookings with no deposits:
  - "Smith & Jones Wedding": wedding, date = London today + 30 days, notes "Evening reception".
  - "Seniors Society Day": society, today + 14 days, notes "36 golfers".

  Starting stock is one `goodsIn` movement per tracked product, with qty = its starting stock, staffId = the setup manager and note "Opening stock". Everything is written in one `transact()`, with one outbox entry per record; the PINs are hashed first. Sample data is offered only at first run, and loading fails with `CONFLICT` if any category or product exists. It creates no period, sales or tabs.

## 20. Time & timezone

### D-101 Clock injection
- **Spec:** §3, §10.
- **Decision:** `src/rules` never reads the clock; any rule that needs time takes an ISO string. The adapter takes `now: () => Date` (default `new Date()`) and `newId`. Services get the same functions through `ServiceContext` (D-118). UI code reads time only through the context or `src/app/clock.ts` (which uses `Date.now()`), so Playwright's `page.clock` controls auto-lock and the backup reminder. Data and service tests inject a fixed or stepping clock.

### D-102 Europe/London, explicitly
- **Spec:** §6.10, §6.11.
- **Decision:** The club's time zone is fixed as `Europe/London` (`CLUB_TIME_ZONE`). It is not the device zone, because the CI machine runs in UTC. All local-date conversion and display use `Intl.DateTimeFormat('en-GB', {timeZone: CLUB_TIME_ZONE, hourCycle:'h23'}).formatToParts`, assembled by hand. Receipts and reports print `DD/MM/YYYY HH:mm` (24-hour); dates print as `DD/MM/YYYY`.
- **Example:** `2026-09-26T13:05:12.345Z` prints as `26/09/2026 14:05`.

### D-103 Report date ranges
- **Spec:** §6.11.
- **Decision:** Ranges are inclusive London dates [fromDate, toDate], with fromDate ≤ toDate and a default of today–today. `localDateRange` converts them to the half-open instants [londonMidnight(from), londonMidnight(to + 1 day)), and a sale is included iff `fromInclusive ≤ createdAt < toExclusive`. To compute londonMidnight('Y-M-D'): t0 = `Date.UTC(Y, M−1, D)`; h = the London hour of t0 (0 in GMT, 1 in BST, because clocks change at 01:00 UTC); result = t0 − h·3600000. The next day is `Date.UTC(Y, M−1, D+1)`.
- **Example:** 26/09/2026 → [2026-09-25T23:00:00.000Z, 2026-09-26T23:00:00.000Z). 29/03/2026 (the spring-forward day) → [2026-03-29T00:00:00.000Z, 2026-03-29T23:00:00.000Z), 23 hours. 25/10/2026 (the fall-back day) → [2026-10-24T23:00:00.000Z, 2026-10-26T00:00:00.000Z), 25 hours.

### D-129 Every `YYYY-MM-DD` date from 0000-01-01 to 9999-12-31 is a valid date
- **Spec:** §4 Booking, §6.9, §6.11, §8; refines D-089, D-102 and D-103.
- **Decision:** The rules accept the same dates as backup validation (D-089): every real proleptic Gregorian calendar date from `0000-01-01` to `9999-12-31`. `rules/time.ts` handles all of them consistently:
  - **Date maths:** `isValidLocalDate`, `addDays` and `londonMidnight` build UTC midnight with `setUTCFullYear`, never `Date.UTC`, which reads years 0–99 as 1900–1999. `addDays` returns a result outside the range in expanded form (`10000-01-01`, `-0001-12-31`), which `isValidLocalDate` rejects.
  - **London midnight:** D-103's t0 − h·3600000 is generalised to t0 − London's UTC offset at t0. Since 1 December 1847 the offset is a whole number of hours, which gives D-103's result unchanged. Before then London kept London Mean Time (GMT−0:01:15), where the D-103 formula gave h = 23 and a result almost a day early.
  - **Wall clock:** the London month, day and time still come from `Intl.DateTimeFormat(…).formatToParts` (D-102), now including seconds. The year is the UTC year, moved by one across New Year, because Intl's year field is era-based and prints year 0000 as year 1 (BC).
- **Why:** A hand-edited backup can hold a booking dated `0026-10-10`, which D-089 accepts. The rules rejected it, so its deposit receipt fell back to the minimal document (D-123) and the booking could not be saved again. Accepting the date only in `isValidLocalDate` would have made `addDays('0026-10-10', 1)` return `1926-10-11`.
- **Example:**
  - `addDays('0100-01-01', -1)` → `0099-12-31`, which is valid, and `formatLocalDate('0026-10-10')` → `10/10/0026`.
  - `londonMidnight('1800-01-01')` → `1800-01-01T00:01:15.000Z` (it was `1799-12-31T01:00:00.000Z`).
  - `londonDateOf('0000-06-01T12:00:00.000Z')` → `0000-06-01` (it was `0001-06-01`).
  - The deal window for 01/01/1800–01/01/1800 reads back as the same dates.

## 21. Members & back office

### D-104 Member search and attach
- **Spec:** §6.5, §6.3.
- **Decision:** Search covers active, non-deleted members and is case-insensitive. The trimmed query needs at least 1 character. A member matches when memberNumber, firstName, lastName or "firstName lastName" contains the query. Results are sorted by lastName then firstName, capped at 20, each shown as `memberNumber — firstName lastName`. Attaching replaces any member already attached and reprices immediately; detaching is free. Attaching needs permission `attachMember` (all roles) and an open period.
- **Example:** Query "arch" → `1001 — Alice Archer`.

### D-105 Field validation
- **Spec:** §4, §6.9.
- **Decision:** All text is trimmed, and names and labels have internal whitespace collapsed.
  - **Product:**
    - name 1..40 characters, unique case-insensitively among non-deleted products;
    - categoryId must be a non-deleted category;
    - pricePence 0..999,999;
    - vatRate from [20, 5, 0] (default 20);
    - memberDiscountEligible default true; stockTracked default true;
    - stockUnit 1..20 characters (default "unit");
    - lowStockLevel 0..9999 (forced to 0 when untracked);
    - buttonColour `#rrggbb` (default the category colour);
    - sortOrder an integer (default the category's highest + 1);
    - active default true.
  - **Category:** name 1..30 characters, unique case-insensitively among non-deleted categories; sortOrder an integer; colour `#rrggbb`.
  - **Deal:** D-013.
  - **Member:** memberNumber 1..12 characters of `[A-Za-z0-9-]`, stored upper-cased and unique among non-deleted members; firstName and lastName 1..40 characters each.
  - **Staff:** D-077.
  - **Settings:**
    - clubName 1..40 characters;
    - receiptFooter 0..200 characters (newlines allowed);
    - autoLockMinutes 1..60;
    - memberDiscountPercent 0..100;
    - devicePrefix D-058.
  - **Booking:** D-026. **Tab label:** D-064. **Stock:** D-080, D-081. **Amounts:** D-001.

### D-106 Where validation and invariants are enforced
- **Spec:** §3 (layers).
- **Decision:** Field validators are pure functions in `src/rules/validation.ts`, which forms and services share. Sale invariants are `src/rules/sale.validateSale`. **Services** call them before every write and throw `AppError('VALIDATION' | 'INVALID_SALE')`. The **data layer** does not import rules. It enforces persistence integrity (ids, timestamps, outbox, append-only, unique receiptNumber, at most one open period, zNumber) and the transactional re-checks inside `commitSale` (D-056). Screens never write except through services.
- **Why:** This keeps the three-layer rule (data never depends on rules) and gives one set of validators.

## 22. Receipts & documents

### D-107 Receipt money layout
- **Spec:** §6.10, §7.
- **Decision:** The items section lists signed amounts that sum to TOTAL (`itemRows`):
  - each line as `{qty} x {name} @ {unit}` with its gross;
  - each deal line as `{name} x{n}` at −saving;
  - `Member discount (#{memberNumber})` at −memberDiscount, whenever a member is attached, even at £0.00;
  - `Deposit applied` at −depositApplied, only when > 0.

  Then come TOTAL, each tender in order (signed), `Change` if > 0, and the VAT summary (rate, net, VAT, gross).

  Refund receipts follow the same rule with their stored negative figures, so their discount lines print positive. Deal savings print as a single `Deal discount` line = negate(Σ line deal) when non-zero.
- **Example:** Sale S1 prints:
  - `3 x Lager @ £4.50  £13.50`
  - `2 x Crisps @ £1.25  £2.50`
  - `Lager 3 for 2  -£4.50`
  - `Member discount (#1042)  -£1.73`
  - `TOTAL £9.77`
  - `Cash £20.00`
  - `Change £10.23`

  Check: 1350 + 250 − 450 − 173 = 977. VAT: 20% net £6.37, VAT £1.28, gross £7.65; 0% net £2.12, VAT £0.00, gross £2.12.

  The refund of 1 Lager prints:
  - `-1 x Lager @ £4.50  -£4.50`
  - `Deal discount  £1.50`
  - `Member discount (#1042)  £0.45`
  - `TOTAL -£2.55`
  - `Cash -£2.55`

  Check: −450 + 150 + 45 = −255.

### D-108 Receipt and report contents
- **Spec:** §6.10, §6.11.
- **Decision:** Every document has a `<title>` for Playwright (`Receipt {receiptNumber}`, `X read`, `Z report {n}`).
  - **Sale receipt:**
    - header: club name, `DD/MM/YYYY HH:mm`, receipt number, staff name, and optional `Tab: {label}` / `Booking: {name}`;
    - the items section (D-107), TOTAL, tenders, change, the VAT summary and the footer (newlines become `<br>`).
  - **Refund receipt:** a `REFUND` heading and `Refund of {original receipt number}`, then the same structure with negative amounts.
  - **Deposit receipt:**
    - a `DEPOSIT` heading and `Deposit — {booking name} ({type label}, {DD/MM/YYYY})`;
    - the amount, tenders and change, and `Deposit balance now £X` (the balance after this deposit);
    - `No VAT - deposit is a prepayment; VAT is charged on the final bill` in place of a VAT summary, then the footer.
  - **X report:** an `X READ` heading, club name, when it was printed and by whom, the period opened at/by, then these figures in order:
    1. gross sales, deal discounts, member discounts, refunds, net takings;
    2. cash tendered, change given, cash refunded, cash total;
    3. card tendered, card refunded, card total;
    4. deposits taken, deposits applied;
    5. no-sale count, void count;
    6. VAT by rate;
    7. float, expected cash.
  - **Z report:** a `Z REPORT {zNumber}` heading, opened at/by and closed at/by, the same figures, then declared cash and variance (labelled `short` or `over`).

### D-109 Opening documents and the popup fallback
- **Spec:** §6.10, §8.
- **Decision:** Each document is a complete HTML string wrapped in a Blob URL (`text/html`) and opened with `window.open(url, '_blank')` right after the commit resolves, while the click's activation is still valid. When the tab opens, the app sets `win.opener = null` and revokes the URL after 60 s. If `window.open` returns null, an on-screen panel shows the same HTML in a sandboxed iframe (`srcdoc`, empty `sandbox`). The panel has **Reprint**, which tries `window.open` again and closes the panel on success, and **Close**. v1 has no receipt-history screen and never calls `window.print()`.

### D-110 Receipt HTML security
- **Spec:** §6.10, §8.
- **Decision:** Every interpolated value goes through `escapeHtml`, which converts `& < > " '`. Footer newlines become `<br>` after escaping. Documents contain no scripts and carry `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`. React screens never use `dangerouslySetInnerHTML`.
- **Example:** A product named `<img src=x onerror=alert(1)>` prints as literal text.

## 23. First run, storage, platform

### D-111 First run
- **Spec:** §6.1, §8.
- **Decision:** Boot opens the Dexie database `club-epos`. If it fails, a full-screen error says "This browser can't store the till's data". If the staff table has zero rows of any status, the Setup screen shows club name, manager name, PIN, confirm PIN and a "Load sample data" checkbox (unticked by default). Submit (`completeFirstRun`):
  1. Validate the form.
  2. Hash the PIN.
  3. `repos.initialise` creates Settings and the manager (transaction 1).
  4. If the box is ticked, `loadSampleData` runs (transaction 2).
  5. `navigator.storage.persist()`.
  6. Auto-login as the manager, landing on the Till with its "No trading period open" prompt.

  If staff already exist, boot shows the login keypad.

### D-112 Storage persistence
- **Spec:** §8.
- **Decision:** `persist()` is called during setup submit. On every app start, if `persisted()` is false, `persist()` is called again. If the API is missing or the result is false, managers see an in-flow, dismissible banner: "This browser may clear the till's data. Install the app and back up regularly." E2E tests must tolerate the banner, because headless Chromium usually returns false.

### D-113 Concurrency and app updates
- **Spec:** §8, §2.
- **Decision:** Only one app tab per device is supported, because two tabs would share the one draft row. Integrity still holds: receipt numbers are allocated inside rw transactions under a unique index. A `vite-plugin-pwa` auto-update reload behaves like a refresh: the draft is restored at the next login, Pay tenders are lost (D-033), and nothing is ever half-written.

### D-114 Future Supabase compatibility
- **Spec:** §3.2, §11.
- **Decision:** These v1 choices keep the switch cheap:
  - Field names are camelCase; the future adapter maps them to snake_case.
  - Every key is a UUID, except the local-only `outbox.seq` and `draft.id`.
  - Every editable entity resolves conflicts last-write-wins on updatedAt.
  - Append-only entities de-duplicate by id.
  - Settings, periods and Z numbers are per device.

  Deferred:
  - The club-wide settings (clubName, receiptFooter, autoLockMinutes, memberDiscountPercent) will need a shared record.
  - Staff payloads in the outbox include PIN hashes.
  - PIN uniqueness across devices is not enforced.

## 24. Testing & errors

### D-115 Contract-suite hooks
- **Spec:** §10.2, §3.2.
- **Decision:**
  - **Entry point:** `tests/data/contract.ts` exports `runRepositoryContract(name, makeStore, deleteDatabase?)`. `makeStore(options: {dbName, now, newId?, failSaleCommitAfterWrites?})` returns a Repos, and each test uses a unique dbName.
  - **Forced failure:** with `failSaleCommitAfterWrites`, `commitSale` throws `FORCED_FAILURE` after all of its writes. That must leave no sale, stock movement, receiptCounter change, tab change, draft change or outbox entry behind.
  - **Outbox:** "one outbox entry per write" is asserted as: new outbox entries = records written, and each payload `toEqual`s the stored record.
  - **Append-only:** asserted by the append-only repositories having no update or delete methods, and by the adapter using Dexie `add`, never `put` (a duplicate id throws ConstraintError → `CONFLICT`).

### D-116 E2E audit verification
- **Spec:** §10.3 journey 5.
- **Decision:** v1 has no audit-log screen. Journey 5 checks the X read's void count (1), then reads IndexedDB directly: database `club-epos` (schema version 1), object store `auditEvents`, asserting one `override` and one `void` event. Object store names are the EntityName values plus `outbox` and `draft`.

### D-117 Error type
- **Spec:** §8.
- **Decision:** One error class, `AppError {code, message, fieldErrors?}` in `src/data/errors.ts`, is thrown by the data layer and the services. The UI shows `message` and branches on `code`. Rules never throw AppError: validators and tenders return result objects, and money helpers throw `RangeError` on programming errors.

### D-118 Services layer and context
- **Spec:** §3 (layers), §10.
- **Decision:** Application use cases live in `src/services/`, the only place that combines rules and repositories. Every service function takes a `ServiceContext {repos, now, newId, storage}` as its first argument, holds no state and imports no React or Dexie. The composition root (`src/app`) creates one clock and one id generator and passes them to both `createLocalAdapter` and `createServiceContext`, and tests do the same. Writing services take an `Authorisation` and assert its action (D-070).

### D-119 Data-layer details the decisions above leave open
- **Spec:** §3.2, §10.2; refines D-051, D-054, D-089 and D-116.
- **Decision:**
  - **IndexedDB version:** Dexie stores `db.version(SCHEMA_VERSION)` as native IndexedDB version `SCHEMA_VERSION × 10`, which is 10. Code that reads the database directly, such as the D-116 e2e check, opens it without a version: `indexedDB.open('club-epos')`. Opening with version 1 fails with a `VersionError`.
  - **Ids in tests:** backup validation requires UUID v4 ids and references (D-089). Any injected `newId` whose records may be exported or imported must therefore return UUID v4 strings, for example `3f9c2a01-7b4d-4e8a-9c1f-000000000001`. The first id an adapter generates at `initialise` is the deviceId, and its first 4 characters become the devicePrefix (D-057).
  - **Repeated soft delete:** `softDelete` of a record that is already deleted returns it unchanged and writes nothing, so no outbox entry.
  - **Listing order:** repository listings with no stated order return rows by createdAt, then id.
  - **Settings patch:** keys outside `SettingsPatch` are ignored at runtime. A key set to `undefined` removes `lastBackupAt` and is ignored for the required fields.
  - **Backup problems:** a file with the wrong format or version is rejected with that one problem. Otherwise up to 10 problems are listed in file order. Unknown top-level keys count as problems, each outbox payload is checked against its entity's row shape, and each audit `detail` is checked against its type (D-084).
- **Why:** These choices surfaced while building the LocalAdapter and the contract suite. Two of them affect other stations: the e2e IndexedDB check and the id generators used in services tests.

### D-124 Service error codes and details the decisions leave open
- **Spec:** §6, §8; refines D-026, D-063, D-077, D-096, D-111 and D-117.
- **Decision:**
  - **Pay open** fails before any tender: an empty basket is `VALIDATION`; a line whose product record is missing, or a missing member, is `NOT_FOUND`; a missing or closed booking is `BOOKING_NOT_OPEN`; a loaded tab that is no longer open is `TAB_NOT_OPEN`. `viewBasket` prices a missing member without a discount and a closed booking without a deposit, so Pay's error is the first the user sees.
  - **Tabs:** New tab, Add to tab and Park preconditions (no lines, tab mode, booking attached, no tab loaded) are `VALIDATION`; loading into a non-empty basket is `BASKET_NOT_EMPTY`; a closed or missing tab is `TAB_NOT_OPEN`.
  - **Bookings:** settling or cancelling with a non-zero balance is `VALIDATION`; editing, settling or cancelling a closed booking is `BOOKING_NOT_OPEN`.
  - **Back office:** deleting a category still used by a live product is `VALIDATION`. The last-manager rule and the self-change rules are `LAST_MANAGER`; reactivating staff without a new PIN is `VALIDATION` with field `pin`. A second `completeFirstRun` is `CONFLICT`. Importing a file that fails `validateBackupValue` is `INVALID_BACKUP`.
  - **Refunds:** a line for a product that is not stock-tracked always stores `returnToStock: true`, because the choice is hidden and nothing is wasted.
  - **Draft restore:** `removedCount` counts each dropped line, member and booking as one item.
  - **Deposit receipt:** "Deposit balance now" is the D-025 balance over the booking's sales up to and including that deposit, so a reprint shows the historical figure.
  - **First run:** `completeFirstRun` returns only the Session (contract). The app reads the persistence result with `checkPersistentStorage()`, whose `persisted()` reflects the grant made during setup.
- **Why:** Screens branch on `code` (D-117), so the codes need to be fixed before the UI is built.

## 25. UI behaviour settled while fixing review findings

### D-130 Basket changes run one at a time; Pay opening and a payment in progress freeze what they cover
- **Spec:** §6.3, §6.4, §6.11, §8; refines D-011, D-033, D-047, D-085 and D-095.
- **Decision:**
  - **One change at a time:** the basket store runs every basket change (add, void, attach or detach a member or booking, load a tab, restore the draft) in a queue. Each change reads the basket only when its turn comes. So two quick taps on '−' are two voids of one unit each (two void events, two units removed), and a product tapped while a void is being written is added to the reduced basket instead of being overwritten. The draft save and re-pricing that follow a change are not queued.
  - **Pay opening:** `openSale` joins the same queue, so it prices the basket after any change already under way. While it runs (`payStore.opening`), every basket change is refused with "Finish or cancel the payment first". Pay therefore always covers exactly the basket; nothing can be added to the basket and then dropped, uncharged and unvoided, when the sale completes.
  - **Z close:** refused while a Pay session of either kind has tenders taken. A deposit payment leaves the basket empty, so the D-047 basket check alone let a Z close run with the deposit's cash already in the drawer: the Z would record it as "over" and the deposit could no longer be saved (NO_OPEN_PERIOD). The Period screen disables Z close with "A payment is in progress. Finish or cancel it before closing the period." and a Back to Pay link; the wizard checks again before Confirm Z close. A Pay session with no tenders does not block it.
- **Why:** Each of these let money be taken or given with no matching record.

### D-131 Pay wording for £0.00 bills and failed deposits
- **Spec:** §6.4, §8; refines D-031 and D-034.
- **Decision:** A £0.00 bill says "The deposit covers the whole bill" only when the frozen pricing applied a deposit (`depositAppliedPence > 0`); otherwise (a £0.00 product, a 100% member discount) it says "The total is £0.00. Complete the sale to save it and print the receipt." A failed deposit commit reads "Deposit not saved: {message}" (a sale keeps "Sale not saved: {message}") and says "The payments taken are kept", since a deposit has no basket. A commit that fails with NO_OPEN_PERIOD also refreshes the cached period, so the header shows "No period open".

### D-132 PIN keypad keyboard use and focus
- **Spec:** §6.2; refines D-073 and D-076.
- **Decision:** Enter on a focused button activates that button, including the keypad's own keys: Enter on Clear clears, Enter on '1' types 1, Enter on Enter submits. Enter with focus anywhere else submits. The keypad group is focusable (tabIndex −1) and is the override dialog's initial focus. Tapping or clicking a key does not move focus onto it, so physical digits and Enter keep working after taps. When an action disables the focused key (Enter after a submit, Clear, the last Delete), focus moves to the keypad group, so it never falls out of the override dialog.
- **Why:** Taking over Enter on the keypad's own keys made Enter on Clear submit the PIN, and a wrong PIN counts towards the lockout.

### D-133 Reloading onto a new build after an update
- **Spec:** §1.1, §2; refines D-113.
- **Decision:** The app registers its service worker through `virtual:pwa-register` (`src/app/serviceWorker.ts`), not an injected script. With `registerType: 'autoUpdate'`, a new worker takes over at once and deletes the old build's files. The client then reloads the page onto the new build, so a lazily loaded screen never asks for a deleted chunk. The reload waits while a payment is in flight: while a Pay session has tenders or is saving, and while Pay is on screen, since it may be showing the change to hand back. It runs as soon as the payment is finished or cancelled and Pay is left. Otherwise it behaves as D-113 says: the draft is restored at the next login.

### D-134 Pay keys hold still and ignore repeat taps; a payment's preconditions are checked where they can go away; focus stays put
- **Spec:** §6.4, §6.7, §6.10, §6.11, §8; refines D-029, D-030, D-033, D-068, D-090, D-109, D-130, D-132 and D-133.
- **Decision:**
  - **Pay double taps:** for 400 ms (`TENDER_REST_MS`, as the Z close wizard's Confirm) after Pay opens and after every tender attempt, accepted or refused, the tender panel ignores taps: pointer events are off, so nothing looks different, and the handlers ignore Enter too. So the second tap of a double tap never takes a second tender. Without this, the second tap on Card after a part tender took the whole remaining balance by card and saved the sale, and a double tap on the till's Pay typed a digit into Pay's keypad.
    - The same rest covers Complete sale on a £0.00 bill when Pay opens.
    - The change screen's New sale / Back to booking and Print receipt again ignore taps for their first 400 ms, so a repeat tap on the tender that finished the payment can't skip the change to hand back.
  - **Pay keys hold still:** nothing above the quick-cash and Exact / Cash / Card keys changes height when a tender is taken or refused.
    - A refusal such as "Card can't be more than the balance" shows under the tender keys.
    - Below 900 px, where the totals card sits above the keys, the tenders taken share one fixed-height "Taken" row that scrolls sideways inside itself ("Nothing yet" before the first).
    - Before this, the new row or the error banner pushed a different money key under the finger, and a repeat tap took cash and saved the sale.
  - **A Pay session outlives its preconditions only with money taken:**
    - After a Z close, a Pay session with no tenders is dropped. It can only be a deposit, because D-047 needs an empty basket, and it could never be saved (D-068). Before, the next login went straight to that stale Pay screen (D-078).
    - After a booking is settled or cancelled, a deposit Pay session for it with no tenders is dropped too.
    - Settling or cancelling is refused while a deposit for that booking has tenders taken: "A deposit payment for this booking is in progress. Finish or cancel it before closing the booking." Otherwise the deposit could no longer be saved (BOOKING_NOT_OPEN).
    - As a backstop, Pay with no open period shows "No trading period open." with Open period, and disables the tender keys and Complete sale. Staff are told not to take money that can't be saved.
  - **Backup import:** refused while a Pay session has tenders: "A payment is in progress. Finish or cancel it before importing a backup.", with Back to Pay. This follows D-130's reasoning for Z close. The import replaces all data and ends the session (D-090), so it would silently drop money already in the drawer. That would be a third way out of Pay, with no hand-back step (D-033).
  - **Update reload:** D-133's reload also waits while the receipt fallback panel is open. The panel holds a blocked receipt, X read or Z report only in memory, and v1 can't reprint a past receipt or Z report (D-109, D-047).
  - **Focus stays put:**
    - A busy `Button` is `aria-disabled` and ignores clicks and form submits, but is not natively disabled, so a focused button keeps keyboard focus. Before, No sale, X read, Run report, Export backup, Find sale and Add product dropped focus to `<body>`, and Add product's dialog then restored focus there.
    - A quantity stepper (Void, Refund) that reaches its limit hands focus to the other stepper.
    - The money keypad's group is focusable and is a dialog's initial focus, as the PIN keypad is (D-132). Before, Open period, Z close's Count cash and Take deposit opened on "Delete last digit", so Enter after typing an amount deleted a digit (£100.00 became £10.00).
    - Enter with the keypad group focused runs the dialog's primary action (Open period, Continue, Continue to Pay). Enter on a focused key still presses that key.
    - The Tab dialog's name/table field stays focusable (read-only) while a tab opens. A refused label focuses the field and is announced (`role="alert"`).
- **Why:** Each of these either took or dropped money with no matching record, or lost the user's place. The service layer was already correct: every case is about what the screen lets staff do before the service refuses.

### D-135 Leaving Pay drops an untendered sale; the receipt panel outlives a lock; focus never falls to `<body>`
- **Spec:** §6.2, §6.4, §6.6, §6.10, §8; refines D-011, D-033, D-063, D-076, D-078, D-109 and D-134.
- **Decision:**
  - **Leaving Pay:** a sale Pay session with no tenders is dropped whenever Pay is left, not only by 'Back to basket' or the Till: the Menu or browser Back drop it too (D-011: "Leaving Pay drops the freeze"). A lock ends the session before Pay closes, so the Pay session survives a lock as D-033 and D-078 say. A session with tenders is always kept (D-033). Before, a price edit made after leaving Pay through the Menu was ignored: the next login went back to Pay (D-078) and charged the superseded price, although D-009 reprices an open basket.
  - **Member discount % on Pay:** `SalePaySession.memberDiscountPercent` records the % the frozen pricing used (null with no member). Pay labels the discount with it, never with the live setting, so a change made while a payment is open cannot show 10% beside a 15% amount.
  - **Emptied tab:** with every line voided, the Tab dialog's button reads **Remove tab** and the toast says "Tab {label} removed (no items left)", since `parkTab` then deletes the tab (D-063 d). It no longer says "Saved to …".
  - **Receipt fallback panel:** only **Close** and **Reprint** close it; Escape and a tap on the backdrop do not. A lock keeps its document: the panel is hidden while the till is locked and shown again after the next login, whoever logs in (as a printout would lie in the tray). It may be the only copy of a receipt, X read or Z report (D-047, D-109), which is why D-134 already holds the update reload for it.
  - **Scroll:** each route opens at the top of `<main>`; the shell resets its scroll when the path changes.
  - **Focus stays on the page:**
    - When a dialog closes and its opener can no longer take focus (disabled or removed, e.g. Void after voiding the only line), focus goes to the nearest container that takes focus from script (`tabindex="-1"`: an open dialog, the basket, `<main>`), not to `<body>`.
    - The same applies when a focused control removes itself: '−' on a line's last unit, Remove member, Remove booking and a banner's dismiss button. The basket panel takes focus (`tabindex="-1"`), so on a phone focus stays inside the open basket sheet.
    - Focus never moves to a neighbouring button, so a repeated Enter cannot void another line or open the drawer.
  - **PIN lockout:** the countdown is a `role="timer"` (not a live region), so it is not read out every second. A polite live region says once "Too many attempts. The keypad is locked for 30 seconds." and, when it ends, "The keypad is unlocked. You can enter a PIN again."
  - **Forced colours (Windows High Contrast):** product buttons keep a border, and the selected category tab, the selected basket line, a chosen search result and a refund line being refunded keep a system `Highlight` marker, since forced colours drop the backgrounds and shadows that show them otherwise.
- **Why:** The first two let a sale be charged at prices it should not have or show the customer contradictory figures; the rest lost the user's place, a document or a tab without saying so.

### D-136 A button that changes screen hands focus to the new screen's heading
- **Spec:** §6.2–§6.11 (every screen is reached from another), WCAG 2.4.3; refines D-135.
- **Decision:** When a control inside a screen changes the route (the till's Pay, Pay's Back to basket / Back to booking / New sale, a booking link, a dialog's Continue to Pay, a banner's Back to Pay), that control goes with the old screen and the browser drops focus to `<body>` (or D-135's fallback puts it on `<main>` when a dialog closes with the screen). The new screen's `<h1>` then takes focus (`tabindex="-1"`, no focus ring, like `<main>` and the basket), so keyboard users continue from the top of the new screen and screen readers announce it by name. The till's visually hidden "Till" heading is included. Focus that is still somewhere is left alone: after the header Menu, focus returns to the Menu button as before; a field with `autoFocus` or a screen's own initial focus (e.g. Pay's New sale) keeps it. The shared `Screen` component does this once when it mounts.
- **Why:** Before, opening Pay or returning to the till left focus on `<body>` and nothing announced the new screen except `document.title`.

### D-137 Only `<main>` scrolls; a locked basket shows what is being charged; a failed draft save stays on screen; adds are announced; focus stays on the page
- **Spec:** §6.2, §6.3, §6.4, §6.7, §6.10, §6.11, §8, docs/ui-plan.md §6 (Layout), WCAG 2.4.3, 3.3.1 and 4.1.3; refines D-011, D-033, D-095, D-132, D-134, D-135 and D-136.
- **Decision:**
  - **Only `<main>` scrolls:** `<main>` is `position: relative`, so it is the containing block of everything absolutely positioned inside it (every `.visually-hidden` span, a table's hidden caption, the backup file input) and its overflow clips them. The shell is `position: relative; overflow: clip`, so nothing inside it can make the document taller than the viewport. Before, 40 hidden price spans on Products (and the Back office menu, Stock, Backup) stretched the document behind the `100dvh` shell: a drag over the header, or a scroll past the end of a list, carried the header (Menu, Lock) off the screen and left a blank page.
  - **A locked basket shows what is being charged:** while a sale Pay session has tenders (D-033), the basket store's `view.priced` is that session's frozen pricing, and the member discount row shows the session's `memberDiscountPercent` (as Pay does, D-135). A price, deal or discount change made in the back office during the payment no longer shows a new total on the till beside "Payment in progress. The basket is locked…". Once the payment is cancelled, the basket is priced at now again (D-009); once it completes, the basket is empty.
  - **A failed draft save stays on screen:** the basket store keeps it in `draftError`, apart from pricing errors, so a successful re-pricing no longer wipes it. The till shows "The basket could not be saved." ("If this page is reloaded now, the latest changes to the basket will be lost.") with **Try again**, which saves the draft of the current basket again. The banner goes when a save of the basket succeeds: Try again, or the next basket change (whose save holds the whole basket). The danger toast still shows as well.
  - **Adds are announced:** the till has a polite live region (inside the open basket sheet on a phone, since the rest of the app is inert behind it). Each product added, by its button or by a line's **+**, is announced as "{name} added. {n} items, {total}.", with the store's figures (WCAG 4.1.3's own shopping-basket example). A refused add already has its toast.
  - **Focus stays on the page (D-135):**
    - Pay's **Cash** key is `aria-disabled`, not natively disabled, while the keypad is empty, so it keeps focus after a part cash tender clears the keypad (it ignores presses until an amount is typed).
    - Deals' **Deactivate / Reactivate** shows busy (aria-disabled) while it saves, so it keeps focus and then shows its new label.
    - A booking's **Mark settled / Cancel booking** and Backup's **Cancel** remove themselves: focus moves to `<main>`, not `<body>`.
    - The login screen, when it opens with focus lost (after Lock or auto-lock, and on start-up), focuses the PIN keypad group, as the override dialog does (D-132): screen readers announce "Enter your PIN", and Enter there submits the PIN typed.
  - **Report dates:** a refused date range moves focus to the first invalid date, whose message is its description, as every other form does.
  - **Hover tints** apply only where the pointer can hover (`@media (hover: hover)`), so on a touch screen the last key or button tapped does not stay shaded as if pressed or selected.
- **Why:** The first let the whole app scroll away; the second showed staff a total other than the one being charged; the third lost basket lines silently after a reload; the rest lost a keyboard or screen-reader user's place or left them without feedback.
