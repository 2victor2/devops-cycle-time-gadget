import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { normalizeConfig } from '../constants.js';
import { extractRecords } from '../compute.js';

const resolver = new Resolver();

// Auth model: Jira reads use api.asApp() (the app's own credentials), NOT
// asUser(). This is a dashboard gadget that leadership *views* — asUser() would
// force every viewer through a per-user "grant access on your behalf" consent
// prompt, which is friction and often fails for non-operators. asApp() makes the
// panel render for anyone who can see the dashboard. Trade-off: data is app-
// scoped, so a viewer sees the aggregated team metrics regardless of their own
// Jira permissions — intended for these non-sensitive team metrics sourced from
// a curated shared filter.

// All site-specific values come from Forge environment variables (set via
// scripts/forge-env.sh from your local .env), so nothing is hardcoded here — the
// app stays portable across sites. The two SLA fields and the request-type field
// vary per Jira instance, so they are required (see .env.example).
const WAIT_SLA_FIELD = process.env.WAIT_SLA_FIELD;
const EXEC_SLA_FIELD = process.env.EXEC_SLA_FIELD;
const REQUEST_TYPE_FIELD = process.env.REQUEST_TYPE_FIELD;
const ENV_FILTER_ID = process.env.CYCLE_TIME_FILTER_ID || '';
const FALLBACK_JQL = process.env.CYCLE_TIME_FALLBACK_JQL || '';

// Only the fields the compute reads — keeps the search response small. The two
// SLA fields come back inline (with their completedCycles), so no extra API call.
const FIELDS = ['assignee', 'priority', REQUEST_TYPE_FIELD, WAIT_SLA_FIELD, EXEC_SLA_FIELD];

// Names of the field-id variables that must be configured for the app to run.
const REQUIRED_FIELD_VARS = {
  WAIT_SLA_FIELD,
  EXEC_SLA_FIELD,
  REQUEST_TYPE_FIELD,
};

/**
 * Resolve the source JQL from the configured filter id. Reading the filter by id
 * keeps the gadget pointed at whatever the team curates in that filter; we only
 * fall back to CYCLE_TIME_FALLBACK_JQL (if set) when the read fails.
 */
async function resolveJql(filterId) {
  if (filterId) {
    try {
      const res = await api
        .asApp()
        .requestJira(route`/rest/api/3/filter/${filterId}`, {
          headers: { Accept: 'application/json' },
        });
      if (res.ok) {
        const data = await res.json();
        if (data && data.jql) return data.jql;
      }
    } catch (e) {
      // fall through to the fallback JQL
    }
  }
  return FALLBACK_JQL;
}

/**
 * Optionally tighten the source JQL with a window override. When the viewer sets
 * windowDays, we AND on `resolved >= -Nd` so the panel can show a shorter span
 * than the filter without editing the filter itself. Blank → JQL unchanged.
 */
function applyWindow(jql, windowDays) {
  if (!windowDays) return jql;
  return `(${jql}) AND resolved >= -${windowDays}d`;
}

/**
 * The Jira site base URL (e.g. https://acme.atlassian.net), used to build
 * absolute issue-navigator links for the compliance view's breach-rate cells.
 * Best-effort: on failure we return '' and the frontend just renders the rate as
 * plain text (no link), so the panel never breaks over this.
 */
async function fetchBaseUrl() {
  try {
    const res = await api
      .asApp()
      .requestJira(route`/rest/api/3/serverInfo`, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      return data.baseUrl || '';
    }
  } catch (e) {
    // fall through to ''
  }
  return '';
}

/**
 * Page through POST /rest/api/3/search/jql with nextPageToken until exhausted.
 * The resolved-last-60d set is modest, but we paginate properly per the spec.
 */
async function fetchAllIssues(jql) {
  const issues = [];
  let nextPageToken;
  let pages = 0;
  const MAX_PAGES = 50; // safety cap against an unbounded loop

  do {
    const body = { jql, maxResults: 100, fields: FIELDS };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await api
      .asApp()
      .requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`search/jql returned ${res.status}: ${text}`);
    }

    const data = await res.json();
    (data.issues || []).forEach((i) => issues.push(i));
    nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
    pages += 1;
  } while (nextPageToken && pages < MAX_PAGES);

  return issues;
}

/**
 * Main entry point invoked by the view. Receives the saved gadget configuration,
 * reads the source filter, extracts per-issue Wait/Execution/Total records, and
 * returns them. Grouping/aggregation happens in the frontend so switching the
 * grouping selector is instant (no re-fetch).
 */
resolver.define('getCycleTime', async (req) => {
  const cfg = normalizeConfig((req.payload && req.payload.config) || {});
  // Per-gadget config wins; otherwise the CYCLE_TIME_FILTER_ID env var.
  const filterId = cfg.filterId || ENV_FILTER_ID;

  // The SLA / request-type field ids are site-specific and have no safe default,
  // so fail fast with a clear message if the app hasn't been configured.
  const missing = Object.entries(REQUIRED_FIELD_VARS)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    return {
      ok: false,
      error: `Missing Forge variable(s): ${missing.join(', ')}. ` +
        'Set them to your site’s field ids (see .env.example) and redeploy.',
    };
  }

  try {
    const baseJql = await resolveJql(filterId);
    if (!baseJql) {
      return {
        ok: false,
        error:
          'No source filter configured. Set a filter id in the gadget config, ' +
          'or a CYCLE_TIME_FILTER_ID / CYCLE_TIME_FALLBACK_JQL Forge variable.',
      };
    }
    const jql = applyWindow(baseJql, cfg.windowDays);
    // baseUrl is independent of the issue fetch, so run them together.
    const [issues, baseUrl] = await Promise.all([fetchAllIssues(jql), fetchBaseUrl()]);
    const records = extractRecords(issues, {
      waitSla: WAIT_SLA_FIELD,
      execSla: EXEC_SLA_FIELD,
      requestType: REQUEST_TYPE_FIELD,
    });
    // jql + baseUrl + the SLA field ids let the frontend build drill-down links
    // from the compliance view's breach-rate cells to the matching issues.
    return {
      ok: true,
      records,
      scanned: issues.length,
      jql,
      baseUrl,
      slaFields: { firstResponse: WAIT_SLA_FIELD, resolution: EXEC_SLA_FIELD },
    };
  } catch (err) {
    console.error('getCycleTime failed', err);
    return { ok: false, error: String(err.message || err) };
  }
});

export const handler = resolver.getDefinitions();
