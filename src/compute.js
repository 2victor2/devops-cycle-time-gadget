/**
 * Pure cycle-time computation — no Forge/network dependencies, so it can be unit
 * tested against live issue JSON offline (see test/compute.test.js). Two stages:
 *
 *   1. extractRecords(): raw search/jql issues → one tidy record per qualifying
 *      issue, carrying its Wait/Execution/Total millis and the three grouping
 *      keys. This is the expensive-to-source part and runs in the resolver.
 *   2. aggregate(): records + a chosen dimension → per-group n, median and
 *      average of Wait/Execution/Total, plus a team-overall row. This is cheap,
 *      so the frontend re-runs it when the viewer switches the grouping selector
 *      — no re-fetch needed.
 *
 * See constants.js for the SLA model (sum completed-cycle elapsedTime per field;
 * Total = Wait + Execution; the two SLAs are sequential so summing is valid).
 */
import {
  PRIORITIES,
  requestTypeName,
  slaElapsedMillis,
} from './constants.js';

// --- statistics ------------------------------------------------------------

// Median of an array of numbers. Right-skewed durations make this the headline
// stat: one slow ticket can't drag the middle the way it drags the mean.
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Arithmetic mean. Shown alongside the median for context.
export function average(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Turn the raw issues from search/jql into per-issue cycle-time records.
 *
 * Population rule (README §2.2): an issue qualifies only if it carries at least
 * one completed SLA cycle — i.e. it actually went through the flow. Issues with
 * no completed cycle on either SLA (still ongoing, or never ran the SLA — Epics /
 * Scope Definition) are skipped. Wait/Execution are summed independently, so an
 * issue missing one SLA still contributes the side it has (the other is 0).
 *
 * @param fieldIds { waitSla, execSla, requestType } — site-specific field ids,
 *   passed in (not hardcoded) so the same code works if a site remaps the fields.
 */
export function extractRecords(issues, fieldIds) {
  const { waitSla, execSla, requestType } = fieldIds;
  const records = [];

  for (const issue of issues) {
    const f = issue.fields || {};

    const wait = slaElapsedMillis(f[waitSla]);
    const exec = slaElapsedMillis(f[execSla]);

    // Skip issues that never completed a cycle on either SLA — they have no
    // ready→resolved duration to report.
    if (wait.cycles === 0 && exec.cycles === 0) continue;

    const assignee = f.assignee;
    const priorityName = (f.priority && f.priority.name) || 'No priority';

    records.push({
      key: issue.key,
      wait: wait.millis,
      exec: exec.millis,
      total: wait.millis + exec.millis,
      // Grouping coordinates, pre-resolved so aggregate() stays dimension-agnostic.
      assigneeId: (assignee && assignee.accountId) || 'unassigned',
      assigneeName: (assignee && assignee.displayName) || 'Unassigned',
      priority: priorityName,
      requestType: requestTypeName(f[requestType]),
    });
  }

  return records;
}

// Map a dimension key to (groupKey, groupLabel) for one record. Assignee groups
// on the stable accountId but displays the name; the others group on the label.
function groupOf(record, dimension) {
  switch (dimension) {
    case 'assignee':
      return { key: record.assigneeId, label: record.assigneeName };
    case 'priority':
      return { key: record.priority, label: record.priority };
    case 'requestType':
      return { key: record.requestType, label: record.requestType };
    default:
      return { key: record.assigneeId, label: record.assigneeName };
  }
}

// Build the median/average summary for one collection of records.
function summarize(records) {
  const waits = records.map((r) => r.wait);
  const execs = records.map((r) => r.exec);
  const totals = records.map((r) => r.total);
  return {
    n: records.length,
    wait: { median: median(waits), average: average(waits) },
    exec: { median: median(execs), average: average(execs) },
    total: { median: median(totals), average: average(totals) },
  };
}

// Sort rows so the table reads sensibly per dimension: priority by severity,
// everything else by descending median Total (slowest groups first).
function sortRows(rows, dimension) {
  if (dimension === 'priority') {
    return rows.sort(
      (a, b) => PRIORITIES.indexOf(a.label) - PRIORITIES.indexOf(b.label),
    );
  }
  return rows.sort((a, b) => b.total.median - a.total.median);
}

/**
 * Group records by the chosen dimension and summarize each group, plus a single
 * "team overall" row across every record. Returns everything the table needs.
 *
 * @returns { dimension, rows: [{ key, label, n, wait, exec, total }], overall }
 */
export function aggregate(records, dimension = 'assignee') {
  const groups = new Map();
  for (const r of records) {
    const g = groupOf(r, dimension);
    if (!groups.has(g.key)) groups.set(g.key, { key: g.key, label: g.label, items: [] });
    groups.get(g.key).items.push(r);
  }

  const rows = sortRows(
    Array.from(groups.values()).map((g) => ({
      key: g.key,
      label: g.label,
      ...summarize(g.items),
    })),
    dimension,
  );

  return {
    dimension,
    rows,
    overall: { key: '__overall__', label: 'Team overall', ...summarize(records) },
  };
}
