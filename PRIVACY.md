# Privacy Policy — Cycle Time (SLA)

_Last updated: 11 June 2026_

Cycle Time (SLA) is an Atlassian Forge app — a Jira Cloud dashboard gadget —
installed on a single Jira Cloud site. This policy describes what data the app
accesses and how it is handled.

## What the app does

It reports, per assignee / priority / request type, the time issues take from
ready to resolved, split into **Wait** (First Response SLA) and **Execution**
(Time to Resolution SLA), and displays the aggregated median and average as a
table in a Jira dashboard gadget.

## Data the app accesses

The app reads Jira issue data from a Jira filter you configure, using Atlassian's
Forge runtime with the app's **own** credentials (`asApp`) and the single scope
**`read:jira-work`**. For each issue returned by that filter it reads only:

- `assignee`, `priority`, and the configured request-type field;
- the two JSM SLA fields (First Response SLA and Time to Resolution SLA), from
  which it sums completed-cycle elapsed time.

It reads this data solely to compute and display the metrics shown in the gadget.

## What the app does NOT do

- **No external transmission.** The app has no external egress and makes no
  network calls outside Atlassian. Data never leaves the Atlassian/Forge
  environment.
- **No storage.** The app persists no data — no database, no Forge storage, no
  cached copies of issue data. Each render reads live data and discards it after
  producing the on-screen result.
- **No selling or sharing.** The app does not collect, sell, or share personal
  information. It surfaces names/avatars only as already present in Jira, and only
  to users who can view the dashboard.
- **No tracking, analytics, or cookies** beyond what the Atlassian platform
  itself provides.

## Where processing happens

All processing runs inside Atlassian's Forge hosted runtime ("Runs on Atlassian").
No third-party processors are involved.

## Access and permissions

Data is read with the app's `read:jira-work` scope. Results are visible only
within the Jira dashboard gadget, to users who have access to that dashboard.

## Changes

Any updates to this policy will be published in this repository.

## Contact

For questions about this app's data handling, open an issue on this repository.
