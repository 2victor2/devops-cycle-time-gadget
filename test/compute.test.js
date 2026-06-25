/**
 * Offline checks for the pure cycle-time compute — no Forge/network needed.
 * Run with `npm test` (node --test). The fixtures mirror the SLA field shape
 * returned by search/jql (issue.fields.<sla>.completedCycles[].elapsedTime.millis)
 * and a verified sample (Wait 3h7m + Exec 9h43m) cross-checked against live data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecords, aggregate, median, average } from '../src/compute.js';
import {
  formatDuration,
  formatRate,
  slaCycleStats,
  breachedClause,
  dimensionClause,
  breachLink,
} from '../src/constants.js';

// Placeholder field ids — extractRecords reads whatever ids it's handed, so the
// tests don't need (or hardcode) any particular site's custom-field numbers.
const FIELDS = {
  waitSla: 'waitSlaField',
  execSla: 'execSlaField',
  requestType: 'requestTypeField',
};

const MIN = 60 * 1000;
const h = (hours, minutes = 0) => (hours * 60 + minutes) * MIN;

// Build a search/jql-shaped issue with one completed cycle per SLA. The optional
// waitBreached/execBreached flags set the `breached` boolean on that cycle so the
// compliance tests can exercise met vs breached counting.
const issue = (
  key,
  { wait, exec, assignee, priority, requestType, waitBreached = false, execBreached = false },
) => ({
  key,
  fields: {
    assignee: assignee
      ? { accountId: `acc-${assignee}`, displayName: assignee }
      : null,
    priority: priority ? { name: priority } : null,
    [FIELDS.waitSla]:
      wait == null
        ? null
        : { completedCycles: [{ elapsedTime: { millis: wait }, breached: waitBreached }] },
    [FIELDS.execSla]:
      exec == null
        ? null
        : { completedCycles: [{ elapsedTime: { millis: exec }, breached: execBreached }] },
    [FIELDS.requestType]: requestType ? { requestType: { name: requestType } } : null,
  },
});

test('Sample ticket: Wait 3h7m + Exec 9h43m = Total 12h50m', () => {
  const recs = extractRecords(
    [issue('SAMPLE-1', { wait: h(3, 7), exec: h(9, 43), assignee: 'Ana', priority: 'High', requestType: 'Bug / Incident' })],
    FIELDS,
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0].wait, h(3, 7));
  assert.equal(recs[0].exec, h(9, 43));
  assert.equal(recs[0].total, h(12, 50));
  assert.equal(formatDuration(recs[0].wait), '3h 7m');
  assert.equal(formatDuration(recs[0].exec), '9h 43m');
  assert.equal(formatDuration(recs[0].total), '12h 50m');
});

test('reopened ticket: completed cycles are summed per SLA', () => {
  const reopened = {
    key: 'SAMPLE-2',
    fields: {
      assignee: { accountId: 'acc-Bo', displayName: 'Bo' },
      priority: { name: 'Medium' },
      [FIELDS.waitSla]: { completedCycles: [{ elapsedTime: { millis: h(1) } }] },
      [FIELDS.execSla]: {
        completedCycles: [
          { elapsedTime: { millis: h(2) } },
          { elapsedTime: { millis: h(3) } },
        ],
      },
      [FIELDS.requestType]: { requestType: { name: 'General Request' } },
    },
  };
  const recs = extractRecords([reopened], FIELDS);
  assert.equal(recs[0].exec, h(5)); // 2h + 3h summed
  assert.equal(recs[0].total, h(6));
});

test('issues with no completed SLA cycle are skipped', () => {
  const ongoing = {
    key: 'SAMPLE-OPEN',
    fields: {
      assignee: { accountId: 'acc-X', displayName: 'X' },
      // ongoingCycle only — never completed a cycle on either SLA.
      [FIELDS.waitSla]: { completedCycles: [], ongoingCycle: {} },
      [FIELDS.execSla]: { completedCycles: [] },
    },
  };
  assert.equal(extractRecords([ongoing], FIELDS).length, 0);
});

test('aggregate: median is the headline; overall spans all records', () => {
  const recs = extractRecords(
    [
      issue('A', { wait: h(1), exec: h(1), assignee: 'Ana', priority: 'High', requestType: 'Bug / Incident' }),
      issue('B', { wait: h(2), exec: h(2), assignee: 'Ana', priority: 'High', requestType: 'Bug / Incident' }),
      issue('C', { wait: h(9), exec: h(9), assignee: 'Ana', priority: 'High', requestType: 'Bug / Incident' }),
    ],
    FIELDS,
  );
  const byAssignee = aggregate(recs, 'assignee');
  assert.equal(byAssignee.rows.length, 1);
  const row = byAssignee.rows[0];
  assert.equal(row.label, 'Ana');
  assert.equal(row.n, 3);
  // median total of 2,4,18h = 4h; average = 8h — median resists the outlier.
  assert.equal(row.total.median, h(4));
  assert.equal(row.total.average, h(8));
  assert.equal(byAssignee.overall.n, 3);
});

test('aggregate groups by each selectable dimension', () => {
  const recs = extractRecords(
    [
      issue('A', { wait: h(1), exec: h(1), assignee: 'Ana', priority: 'High', requestType: 'Bug / Incident' }),
      issue('B', { wait: h(3), exec: h(3), assignee: 'Bo', priority: 'Low', requestType: 'Access Request' }),
    ],
    FIELDS,
  );
  assert.equal(aggregate(recs, 'assignee').rows.length, 2);
  assert.equal(aggregate(recs, 'priority').rows.length, 2);
  assert.equal(aggregate(recs, 'requestType').rows.length, 2);
  // priority rows are ordered by severity (High before Low).
  assert.deepEqual(
    aggregate(recs, 'priority').rows.map((r) => r.label),
    ['High', 'Low'],
  );
});

test('median/average helpers handle empties and parity', () => {
  assert.equal(median([]), 0);
  assert.equal(average([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(average([2, 4]), 3);
});

test('formatDuration renders compact business time', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(h(0, 45)), '45m');
  assert.equal(formatDuration(h(2)), '2h');
  assert.equal(formatDuration(h(2, 30)), '2h 30m');
});

test('formatDuration floors to match Jira friendly labels (SAMPLE-1 raw millis)', () => {
  // Raw elapsedTime.millis pulled live from the SLA fields on SAMPLE-1.
  assert.equal(formatDuration(11257171), '3h 7m'); // First Response SLA
  assert.equal(formatDuration(35004105), '9h 43m'); // Time to Resolution SLA
});

// --- SLA compliance (met vs breached) --------------------------------------

test('slaCycleStats counts met vs breached per completed cycle', () => {
  const field = {
    completedCycles: [
      { elapsedTime: { millis: h(1) }, breached: false },
      { elapsedTime: { millis: h(2) }, breached: true },
      { elapsedTime: { millis: h(3) }, breached: false },
    ],
  };
  const s = slaCycleStats(field);
  assert.equal(s.cycles, 3);
  assert.equal(s.breached, 1);
  assert.equal(s.met, 2);
  assert.equal(s.millis, h(6)); // durations still sum across all cycles
});

test('slaCycleStats: missing field / no cycles → zeroed, not breached', () => {
  assert.deepEqual(slaCycleStats(null), { millis: 0, cycles: 0, met: 0, breached: 0 });
  assert.deepEqual(slaCycleStats({ completedCycles: [] }), {
    millis: 0,
    cycles: 0,
    met: 0,
    breached: 0,
  });
});

test('extractRecords carries per-SLA met/breached counts', () => {
  const recs = extractRecords(
    [issue('C-1', { wait: h(1), exec: h(2), assignee: 'Ana', waitBreached: false, execBreached: true })],
    FIELDS,
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0].waitMet, 1);
  assert.equal(recs[0].waitBreached, 0);
  assert.equal(recs[0].execMet, 0);
  assert.equal(recs[0].execBreached, 1);
});

test('reopened ticket: met/breached counted per cycle (not collapsed per issue)', () => {
  // Execution SLA ran twice: once met, once breached → 1 met + 1 breached.
  const reopened = {
    key: 'C-2',
    fields: {
      assignee: { accountId: 'acc-Bo', displayName: 'Bo' },
      [FIELDS.waitSla]: { completedCycles: [{ elapsedTime: { millis: h(1) }, breached: false }] },
      [FIELDS.execSla]: {
        completedCycles: [
          { elapsedTime: { millis: h(2) }, breached: false },
          { elapsedTime: { millis: h(3) }, breached: true },
        ],
      },
    },
  };
  const recs = extractRecords([reopened], FIELDS);
  assert.equal(recs[0].execMet, 1);
  assert.equal(recs[0].execBreached, 1);
});

test('aggregate compliance: per-SLA met/breached sum + breach rate per group', () => {
  const recs = extractRecords(
    [
      issue('A', { wait: h(1), exec: h(1), assignee: 'Ana', execBreached: true }),
      issue('B', { wait: h(2), exec: h(2), assignee: 'Ana', execBreached: false }),
      issue('C', { wait: h(1), exec: h(1), assignee: 'Ana', execBreached: false }),
    ],
    FIELDS,
  );
  const ana = aggregate(recs, 'assignee').rows[0].compliance;
  // First Response: 3 cycles, none breached.
  assert.equal(ana.firstResponse.cycles, 3);
  assert.equal(ana.firstResponse.breached, 0);
  assert.equal(ana.firstResponse.rate, 0);
  // Time to Resolution: 3 cycles, 1 breached → rate 1/3.
  assert.equal(ana.resolution.cycles, 3);
  assert.equal(ana.resolution.breached, 1);
  assert.equal(ana.resolution.met, 2);
  assert.ok(Math.abs(ana.resolution.rate - 1 / 3) < 1e-9);
});

test('aggregate compliance: overall row spans every record', () => {
  const recs = extractRecords(
    [
      issue('A', { wait: h(1), exec: h(1), assignee: 'Ana', execBreached: true }),
      issue('B', { wait: h(2), exec: h(2), assignee: 'Bo', waitBreached: true }),
    ],
    FIELDS,
  );
  const overall = aggregate(recs, 'assignee').overall.compliance;
  assert.equal(overall.firstResponse.breached, 1);
  assert.equal(overall.resolution.breached, 1);
  assert.equal(overall.firstResponse.cycles, 2);
  assert.equal(overall.resolution.cycles, 2);
});

test('formatRate: percent string, dash when no cycles', () => {
  assert.equal(formatRate(1, 3), '33%');
  assert.equal(formatRate(0, 5), '0%');
  assert.equal(formatRate(7, 7), '100%');
  assert.equal(formatRate(0, 0), '—');
  assert.equal(formatRate(3, 0), '—');
});

// --- breach drill-down links -----------------------------------------------

test('breachedClause: completed() AND everBreached() on the cf[id] field', () => {
  // Verified live to match the panel's completed-cycle breached count.
  assert.equal(
    breachedClause('customfield_10579'),
    'cf[10579] = completed() AND cf[10579] = everBreached()',
  );
  assert.equal(breachedClause(''), ''); // unconfigured → no clause
});

test('dimensionClause: assignee/priority linkable, request type not', () => {
  const ana = { key: 'acc-1', label: 'Ana' };
  assert.equal(dimensionClause('assignee', ana), 'assignee = "acc-1"');
  assert.equal(
    dimensionClause('assignee', { key: 'unassigned', label: 'Unassigned' }),
    'assignee IS EMPTY',
  );
  assert.equal(dimensionClause('priority', { key: 'High', label: 'High' }), 'priority = "High"');
  assert.equal(
    dimensionClause('priority', { key: 'No priority', label: 'No priority' }),
    'priority IS EMPTY',
  );
  // Overall row → empty clause (linkable, no group filter).
  assert.equal(dimensionClause('assignee', { key: '__overall__', label: 'Team overall' }), '');
  // Request type can't be matched by display name in JQL → not linkable.
  assert.equal(dimensionClause('requestType', { key: 'Bug', label: 'Bug' }), null);
});

test('breachLink: builds an encoded navigator URL, strips ORDER BY', () => {
  const url = breachLink({
    baseUrl: 'https://x.atlassian.net',
    jql: 'project = DEVOPS AND resolution = Done ORDER BY resolved DESC',
    dimension: 'assignee',
    row: { key: 'acc-1', label: 'Ana' },
    slaFieldId: 'customfield_10579',
  });
  assert.ok(url.startsWith('https://x.atlassian.net/issues/?jql='));
  const jql = decodeURIComponent(url.split('jql=')[1]);
  assert.equal(
    jql,
    '(project = DEVOPS AND resolution = Done) AND assignee = "acc-1" ' +
      'AND cf[10579] = completed() AND cf[10579] = everBreached() ORDER BY resolved DESC',
  );
});

test('breachLink: overall row omits the group clause', () => {
  const url = breachLink({
    baseUrl: 'https://x.atlassian.net',
    jql: 'project = DEVOPS',
    dimension: 'assignee',
    row: { key: '__overall__', label: 'Team overall' },
    slaFieldId: 'customfield_10580',
  });
  const jql = decodeURIComponent(url.split('jql=')[1]);
  assert.equal(
    jql,
    '(project = DEVOPS) AND cf[10580] = completed() AND cf[10580] = everBreached() ORDER BY resolved DESC',
  );
});

test('breachLink: null when not linkable (request type, no base URL, no field)', () => {
  const ctx = {
    baseUrl: 'https://x.atlassian.net',
    jql: 'project = DEVOPS',
    dimension: 'assignee',
    row: { key: 'acc-1', label: 'Ana' },
    slaFieldId: 'customfield_10579',
  };
  assert.equal(breachLink({ ...ctx, dimension: 'requestType', row: { key: 'Bug', label: 'Bug' } }), null);
  assert.equal(breachLink({ ...ctx, baseUrl: '' }), null);
  assert.equal(breachLink({ ...ctx, slaFieldId: '' }), null);
  assert.equal(breachLink({ ...ctx, jql: '' }), null);
});
