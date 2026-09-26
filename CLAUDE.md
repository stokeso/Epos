# Club EPOS — working notes for agents

A browser-based till for a golf-club bar, built as a learning project.
The source of truth is `docs/design-spec.md`. Where the spec is silent or ambiguous,
`docs/decisions.md` records the decision taken; follow it, and add to it rather than
deciding silently.

## Commands

| Task | Command |
|---|---|
| Type-check | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit + data tests | `npm test` (Vitest; `npx vitest run tests/rules` to scope) |
| End-to-end | `CI=1 npx playwright test` (builds, then serves on :4173; both viewports) |
| All fast gates | `npm run check` |
| Dev server | `npm run dev` |

Playwright uses the pre-installed Chromium at `/opt/pw-browsers/chromium`. Never run `playwright install`.

## Architecture rules (spec §3)

- Three layers: `src/screens` + `src/components` → `src/rules` (pure) → `src/data` (repository interfaces).
- `src/rules/**` is pure TypeScript: no React, no Dexie, no storage, no `Date.now()` inside pricing maths (pass times in).
- Only `src/data/local/**` may import Dexie. Everything else uses the interfaces in `src/data/repos.ts`. ESLint enforces this.
- Money is **integer pence** everywhere. Never use floating-point amounts; never divide pence without an explicit rounding helper from `src/rules/money.ts`.
- Sales and stock movements are append-only. A refund is a new sale with negative lines.
- Every write appends one outbox entry.
- Zustand holds screen and basket state only; persistent data lives in the data layer.

## Conventions

- TypeScript `strict` with `noUncheckedIndexedAccess`. No `any`, no `@ts-ignore`.
- British English in UI copy; amounts shown as `£1.23`.
- Tests: rules and data tests go in `tests/rules` and `tests/data`; UI unit tests in `tests/unit`; Playwright journeys in `tests/e2e`.
- Rules are written test-first with exact expected pence.
- Do not run `git commit`, `git push` or any other git write command unless your task explicitly says to.
