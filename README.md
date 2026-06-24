# Cycle Time (SLA) — Jira Cloud dashboard gadget

A custom **Atlassian Forge** dashboard gadget for Jira Cloud (Jira Service
Management) with two views over the same data, switchable live on the panel:

> **Durations** — How long does work take from _ready_ to _resolved_, and how
> much of that is waiting in a queue versus hands-on execution?
>
> **SLA met vs breached** — What share of each SLA's completed cycles met their
> goal versus breached it?

Both roll up per **assignee / priority / request type**. The **Durations** view
breaks each issue's cycle time into **Wait** and **Execution** and reports the
**median** (headline) and **average**. The **SLA met vs breached** view counts
completed SLA cycles by their breach flag and shows a met/breached bar plus the
breach rate per SLA. Both read two native JSM SLA fields, so there is **no
changelog parsing and no custom working-calendar math**.

---

## How it works

### The two SLAs

JSM already models the two halves of cycle time as SLAs, and on a standard
request flow they are **sequential and non-overlapping** — the First Response
SLA stops exactly when the Time to Resolution SLA starts. Both are
**business-hours-aware** (the working calendar is already applied), so the
elapsed times are calendar-correct and **summing them is valid**.

| Metric | Source SLA | Meaning |
|---|---|---|
| **Wait** | First Response SLA | assigned/ready → work picked up (queue delay) |
| **Execution** | Time to Resolution SLA | in progress → resolved (hands-on) |
| **Total** | Wait + Execution | **ready → resolved** (the headline) |

### Per-issue computation

For each issue, and for each of the two SLA fields, the gadget **sums
`completedCycles[].elapsedTime.millis`**. Summing (rather than taking a single
cycle) correctly handles **reopened** tickets that ran an SLA more than once.

```
Wait      = Σ First Response SLA completed-cycle elapsed time
Execution = Σ Time to Resolution SLA completed-cycle elapsed time
Total     = Wait + Execution
```

Issues with **no completed SLA cycle** on either field (still ongoing, or issue
types that don't carry these SLAs such as Epics) are **skipped** — they have no
ready→resolved duration to report. The panel shows both counts ("70 issues · 77
scanned") so that exclusion is visible rather than silent.

### Aggregation

Records are grouped by a **selectable dimension** — assignee, priority, or
request type — and each group reports **n**, plus the **median and average** of
Wait, Execution, and Total. A pinned **Team overall** row summarizes everything.

> **Why median is the headline:** durations are right-skewed, so one slow ticket
> drags the average but not the middle. The average is shown alongside for
> context.

### SLA met vs breached

The same per-issue records also carry, for each SLA, how many completed cycles
**met** their goal versus **breached** it (`completedCycles[].breached`). The
compliance view sums these per group and renders, **per SLA** (First Response and
Time to Resolution):

- a proportional **met (green) / breached (red) bar** with the raw `met/total`
  count, and
- the **breach rate** (`breached / total`) as a coloured lozenge.

Counting is **per completed cycle**, not per issue — a reopened ticket whose SLA
ran more than once contributes each run, so a ticket that breached once and met
once shows up as one of each. Rows default to **worst resolution breach rate
first**; any column is sortable. The population is the same completed-work set as
the Durations view (the source filter's resolved-in-window issues) — open or
still-running SLAs are not counted.

---

## Architecture

One Forge app, one `jira:dashboardGadget` module (view + edit) and a resolver.

| File | Responsibility |
|---|---|
| `src/resolvers/index.js` | Reads the source filter's JQL, paginates `POST /rest/api/3/search/jql`, returns one record per qualifying issue. Auth `asApp()`. |
| `src/compute.js` | Pure, testable logic: `extractRecords()` (per-issue Wait/Execution/Total) and `aggregate()` (group + median/average + overall). No Forge/network deps. |
| `src/constants.js` | Config model, selectable groupings/statistics, and shared pure helpers (`slaElapsedMillis`, `formatDuration`, `requestTypeName`). |
| `src/frontend/index.jsx` | UI Kit **View** (grouping selector + table) and **Edit** (config form). |

Design notes:

- **Auth `asApp()`** — Jira reads use the app's own credentials so the panel
  renders for any dashboard viewer without a per-user "grant access" consent
  prompt. (As a viewed leadership gadget, viewer-scoped `asUser()` would force
  each person through that prompt.) Data is therefore app-scoped: a viewer sees
  the aggregated team metrics regardless of their own Jira permissions — intended
  here, since the source is a curated shared filter of non-sensitive team
  metrics. The single scope is **`read:jira-work`**. **No external egress.**
- The resolver does the expensive Jira fetch once; **switching the grouping
  selector re-aggregates client-side** (no refetch).
- `search/jql` is paginated via `nextPageToken`, with a safety page cap.
- The two SLA fields and the request-type field are read inline from the search
  response, so there is no separate API call on the core path.

---

## Configuration

Site-specific values are **never hardcoded** — they come from Forge environment
variables, so the app is portable across sites. Copy `.env.example` to `.env`
and fill in:

| Variable | Required | Purpose |
|---|---|---|
| `APP_ID` | yes | Your registered Forge app id (`forge register`). Injected into `manifest.yml` as `${APP_ID}`. |
| `WAIT_SLA_FIELD` | yes | Custom-field id of the **First Response SLA** (the "Wait" half). |
| `EXEC_SLA_FIELD` | yes | Custom-field id of the **Time to Resolution SLA** (the "Execution" half). |
| `REQUEST_TYPE_FIELD` | yes | Custom-field id of the JSM **Request Type** field. |
| `CYCLE_TIME_FILTER_ID` | recommended | Default saved-filter id the gadget reads. Overridable per gadget in the config UI. |
| `CYCLE_TIME_FALLBACK_JQL` | optional | JQL used only if the filter can't be read. |

Find your custom-field ids under **Jira settings → Issues → Custom fields**, or
via `GET /rest/api/3/field`.

Each placed gadget also has an **edit form** for: source filter id, default view
(durations / SLA met vs breached), default grouping, statistic (median / average
/ both, for the durations view), and an optional window (in days) that tightens
the query with `resolved >= -Nd`.

---

## Prerequisites

- Node 22.x / 24.x + npm (Forge CLI requirement)
- Forge CLI: `npm i -g @forge/cli`
- A Forge account (`forge login`) and site-admin on the target Jira Cloud site
- Scope: `read:jira-work`

## Setup, deploy & install

```bash
npm install
npm test                       # offline unit tests for the compute

npm i -g @forge/cli
forge login
forge register                 # creates a new app id → put it in .env as APP_ID

cp .env.example .env           # then fill in APP_ID and the field/filter ids

# Push runtime variables to Forge and export APP_ID for manifest ${APP_ID}:
source scripts/forge-env.sh --set-variables

forge deploy --non-interactive -e development
forge install --site <your-site>.atlassian.net --product jira \
  --environment development --confirm-scopes --non-interactive
```

Then open the target dashboard, choose **Add gadget**, and pick **Cycle Time
(SLA)**. Use the gadget's edit (pencil) menu to set the source filter and
display options.

For iteration without redeploying, use `forge tunnel` (after `source
scripts/forge-env.sh`).

## Development

```bash
npm test          # node --test — pure compute, no network
npm run lint      # eslint
forge lint        # validates the manifest
```

The compute is intentionally pure (`src/compute.js`) so it can be verified
offline against real issue JSON — the tests cross-check the SLA-cycle summing,
the skip rule, the median/average rollups, and duration formatting (which floors
minutes to match Jira's own SLA labels, e.g. `11257171ms → "3h 7m"`).

---

## License

[GNU General Public License v3.0](LICENSE) — see `LICENSE` for the full text.
