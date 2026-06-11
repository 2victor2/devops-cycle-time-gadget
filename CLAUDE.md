# CLAUDE.md — building the Cycle Time (SLA) gadget

You're building **one Atlassian Forge app** with a single Jira Cloud dashboard
gadget. **`README.md` has the full spec — read it first.** This is the operating
guide.

## What you're building

A `jira:dashboardGadget` that reports, per **assignee / priority / request type**,
the time from **ready → resolved**, split into **Wait** (First Response SLA) and
**Execution** (Time to Resolution SLA), plus **Total = Wait + Execution**. Lives
as a panel on a Jira leadership dashboard.

## Scaffold by reusing the template

**Copy and adapt `../devops-workload-index`** — don't start from a blank
`forge create`. Reuse its `manifest.yml` shape (`${APP_ID}`, `read:jira-work`,
resolver), `scripts/forge-env.sh`, `.env.example`, `package.json` (keep the
`@compiled/react` override), and the `resolvers`/`compute`/`constants`/`frontend`
patterns. Use a **new** `APP_ID` (`forge register`) — this is a separate app.

## Ground truth

- Site-specific values (cloudId, site URL, the SLA / request-type field ids, and
  the default source filter id) are **not hardcoded** — they come from Forge
  environment variables (see `.env.example`): `WAIT_SLA_FIELD` (First Response
  SLA), `EXEC_SLA_FIELD` (Time to Resolution SLA), `REQUEST_TYPE_FIELD`, and
  `CYCLE_TIME_FILTER_ID`. Priority is the native `priority` field.
- The two SLAs are **sequential & non-overlapping** (FR stop == Resolution start),
  both **business-hours-aware** — so summing is valid and **no changelog/calendar
  math is needed**. Per SLA, **sum `completedCycles[].elapsedTime.millis`** (handles
  reopens). Verified against a live sample: Wait 3h7m + Exec 9h43m.

## Invariants (don't change without asking Victor)

- Cycle metrics come from the **native SLA fields**, not recomputed from changelog.
- Total = Wait + Execution; keep all three reported separately.
- **Median is the headline** statistic (right-skewed durations); show average too.
- Group by `assignee | priority | request type` (selectable). Population =
  resolved last 60d with SLA completed cycles (3 `[System]` types); skip those
  without completed cycles.
- Auth **`asApp()`** (so the viewed dashboard panel renders for any leadership
  viewer without a per-user consent prompt); scope **`read:jira-work`** only; **no external egress**;
  paginate `search/jql` via `nextPageToken`.

## Guardrails

- **Never commit secrets / the real `.env`.** `.gitignore` excludes `.env*`,
  `node_modules`, Forge logs. The `forge login` token must never land here.
- Keep aggregation pure/testable (`compute.js` pattern); verify offline against
  real issue JSON before deploying.
- Don't add scopes beyond `read:jira-work` without a reason. UI-Kit frontend
  can't read `process.env` — backend config flows through the resolver.

## How to verify

- `forge lint` clean, `forge deploy` succeeds, `forge tunnel` for iteration.
- Cross-check durations against the `README.md §2.1` sample (DEVOPS-794) and the
  raw SLA `completedCycles[].elapsedTime` on a few tickets.

## When done

Tell Victor — he adds the gadget to the target leadership dashboard via
"Add gadget". Build order: get Wait/Execution/Total compute right against real
tickets before
building the grouping selector + config form.
