/**
 * Single source of truth for the Cycle Time gadget — the config shape, its
 * defaults, the selectable dimensions/statistics, and the pure helpers shared by
 * the resolver and the view. Keeping these here means weights/labels/coercion are
 * never duplicated across backend and frontend.
 *
 * Model (README §2.2): per issue we read two native JSM SLA fields and sum each
 * one's completed-cycle elapsed time:
 *   Wait      = Σ First Response SLA completed cycles      (queue delay)
 *   Execution = Σ Time to Resolution SLA completed cycles  (hands-on)
 *   Total     = Wait + Execution                           (ready → resolved)
 * The two SLAs are sequential and business-hours-aware, so summing is valid and
 * no changelog/calendar math is needed.
 */

// The dimension a viewer can group by. `key` is what we store/aggregate on;
// `label` is shown in the selector and the table header.
export const GROUPINGS = [
  { key: 'assignee', label: 'Assignee' },
  { key: 'priority', label: 'Priority' },
  { key: 'requestType', label: 'Request type' },
];

// Which statistic columns the table shows. Median is the headline (durations are
// right-skewed, so one slow ticket shouldn't dominate); average is shown for
// context. `both` shows the two side by side.
export const STATISTICS = [
  { key: 'median', label: 'Median' },
  { key: 'average', label: 'Average' },
  { key: 'both', label: 'Median + Average' },
];

// The metric a viewer can switch between on the panel (a live toggle, like the
// grouping). `durations` is the original Wait/Execution/Total view; `compliance`
// is the SLA met-vs-breached view (counts completed cycles by their breach flag).
// Both are derived from the same fetched records — switching never re-fetches.
export const VIEWS = [
  { key: 'durations', label: 'Durations' },
  { key: 'compliance', label: 'SLA met vs breached' },
];

// Native Jira priorities, heaviest → lightest. Used to order priority groups so
// the table reads top-down by severity rather than alphabetically.
export const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

/**
 * Default gadget configuration. Shipped so the gadget produces correct output
 * before anyone opens the config form.
 *  - filterId:   blank → fall back to the CYCLE_TIME_FILTER_ID Forge variable.
 *  - grouping:   initial dimension; the viewer can still switch it live.
 *  - metric:     initial view (durations | compliance); viewer can switch it live.
 *  - statistic:  which of median/average/both columns to render (durations view).
 *  - windowDays: optional extra `resolved >= -Nd` clause AND-ed onto the source
 *                JQL. Blank → use the filter as-is (the source filter typically
 *                already constrains the window, e.g. resolved in the last 60d).
 */
export const DEFAULT_CONFIG = {
  filterId: '',
  grouping: 'assignee',
  metric: 'durations',
  statistic: 'both',
  windowDays: '',
};

// --- coercion helpers ------------------------------------------------------
// Gadget configuration is persisted as strings (form fields), so every read must
// coerce and fall back to the default when blank/invalid.

const str = (v, fallback) => {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === '' ? fallback : s;
};

// A constrained string: must be one of `allowed`, else falls back.
const oneOf = (v, allowed, fallback) => {
  const s = str(v, fallback);
  return allowed.includes(s) ? s : fallback;
};

// A positive integer, or the fallback (used for the optional window). An empty
// value is preserved as '' so "no window override" stays distinct from "0 days".
const posIntOrBlank = (v, fallback) => {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? String(n) : fallback;
};

/**
 * Turn a raw saved configuration (flat string keys, possibly partial/empty) into
 * a fully-populated, validated config object used by compute + display. Unknown
 * or blank fields fall back to DEFAULT_CONFIG, so the result is always complete.
 */
export function normalizeConfig(raw = {}) {
  const d = DEFAULT_CONFIG;
  const r = raw || {};
  return {
    filterId: str(r.filterId, d.filterId),
    grouping: oneOf(r.grouping, GROUPINGS.map((g) => g.key), d.grouping),
    metric: oneOf(r.metric, VIEWS.map((v) => v.key), d.metric),
    statistic: oneOf(r.statistic, STATISTICS.map((s) => s.key), d.statistic),
    windowDays: posIntOrBlank(r.windowDays, d.windowDays),
  };
}

/**
 * Flat string defaults keyed exactly as the config form fields (and as the saved
 * gadget configuration). Used to pre-fill the edit form; the saved config is
 * spread on top so existing values win.
 */
export function defaultFlatConfig() {
  const d = DEFAULT_CONFIG;
  return {
    filterId: String(d.filterId),
    grouping: String(d.grouping),
    metric: String(d.metric),
    statistic: String(d.statistic),
    windowDays: String(d.windowDays),
  };
}

/**
 * Pull the display name out of a JSM request-type field value. The field nests
 * the type under `.requestType`; fall back to a top-level name, then to a stable
 * "Unknown" bucket so the row is never lost.
 */
export function requestTypeName(fieldValue) {
  if (!fieldValue) return 'Unknown';
  const rt = fieldValue.requestType || fieldValue;
  return (rt && rt.name) ? String(rt.name) : 'Unknown';
}

/**
 * Reduce a single SLA field's completed cycles to the numbers both views need:
 *  - millis:   summed elapsed business-time (durations view). Summing rather than
 *              taking the last cycle correctly handles reopened tickets that ran
 *              the SLA more than once.
 *  - cycles:   completed-cycle count, so callers can tell "0 because it was
 *              instant" from "0 because it never completed a cycle".
 *  - met/breached: completed cycles counted by their `breached` flag (compliance
 *              view). Counted per cycle — a reopened ticket whose SLA breached on
 *              one run and met on another contributes to both. A cycle is breached
 *              only when `breached === true`; anything else counts as met.
 */
export function slaCycleStats(slaFieldValue) {
  const cycles = (slaFieldValue && slaFieldValue.completedCycles) || [];
  let millis = 0;
  let breached = 0;
  for (const c of cycles) {
    if (c && c.elapsedTime && Number.isFinite(c.elapsedTime.millis)) {
      millis += c.elapsedTime.millis;
    }
    if (c && c.breached === true) breached += 1;
  }
  return { millis, cycles: cycles.length, met: cycles.length - breached, breached };
}

/**
 * Breach rate as a whole-percent string ("11%"). `total` is met + breached
 * completed cycles for the SLA; 0 total → "—" (no data to rate, not "0%").
 */
export function formatRate(breached, total) {
  if (!Number.isFinite(total) || total <= 0) return '—';
  return `${Math.round((breached / total) * 100)}%`;
}

/**
 * Render a duration in milliseconds as a compact human string ("3h 7m").
 * SLA elapsed time is already business-hours-aware, so these read as working
 * time. Minute-resolution is plenty for a leadership panel.
 */
export function formatDuration(millis) {
  if (!Number.isFinite(millis) || millis <= 0) return '0m';
  // Floor to whole minutes to match Jira's own SLA "friendly" rendering
  // (e.g. 11257171ms → "3h 7m", not "3h 8m").
  const totalMinutes = Math.floor(millis / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
