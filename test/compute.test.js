/**
 * Offline checks for the pure cycle-time compute — no Forge/network needed.
 * Run with `npm test` (node --test). The fixtures mirror the SLA field shape
 * returned by search/jql (issue.fields.<sla>.completedCycles[].elapsedTime.millis)
 * and a verified sample (Wait 3h7m + Exec 9h43m) cross-checked against live data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecords, aggregate, median, average } from '../src/compute.js';
import { formatDuration } from '../src/constants.js';

// Placeholder field ids — extractRecords reads whatever ids it's handed, so the
// tests don't need (or hardcode) any particular site's custom-field numbers.
const FIELDS = {
  waitSla: 'waitSlaField',
  execSla: 'execSlaField',
  requestType: 'requestTypeField',
};

const MIN = 60 * 1000;
const h = (hours, minutes = 0) => (hours * 60 + minutes) * MIN;

// Build a search/jql-shaped issue with one completed cycle per SLA.
const issue = (key, { wait, exec, assignee, priority, requestType }) => ({
  key,
  fields: {
    assignee: assignee
      ? { accountId: `acc-${assignee}`, displayName: assignee }
      : null,
    priority: priority ? { name: priority } : null,
    [FIELDS.waitSla]:
      wait == null ? null : { completedCycles: [{ elapsedTime: { millis: wait } }] },
    [FIELDS.execSla]:
      exec == null ? null : { completedCycles: [{ elapsedTime: { millis: exec } }] },
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
