import React, { useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Text,
  Heading,
  Strong,
  Box,
  Stack,
  Inline,
  Lozenge,
  Link,
  Spinner,
  SectionMessage,
  DynamicTable,
  Select,
  Form,
  FormSection,
  FormFooter,
  Label,
  Textfield,
  Button,
  HelperMessage,
  ErrorMessage,
  useConfig,
  useProductContext,
  useForm,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';
import {
  GROUPINGS,
  STATISTICS,
  VIEWS,
  defaultFlatConfig,
  normalizeConfig,
  formatDuration,
  formatRate,
  breachLink,
} from '../constants.js';
import { aggregate } from '../compute.js';

// ---------------------------------------------------------------------------
// VIEW — grouping selector + Wait / Execution / Total table
// ---------------------------------------------------------------------------

const groupingLabel = (key) => {
  const g = GROUPINGS.find((x) => x.key === key);
  return g ? g.label : key;
};

/**
 * Render one duration metric ({ median, average }) honouring the configured
 * statistic. For "both" the median leads (it's the headline) with the average in
 * muted parentheses; otherwise just the chosen one.
 */
const MetricCell = ({ metric, statistic }) => {
  if (statistic === 'median') return <Text>{formatDuration(metric.median)}</Text>;
  if (statistic === 'average') return <Text>{formatDuration(metric.average)}</Text>;
  return (
    <Text>
      <Strong>{formatDuration(metric.median)}</Strong>{' '}
      <Text as="span" color="color.text.subtlest">
        ({formatDuration(metric.average)})
      </Text>
    </Text>
  );
};

// Column header suffix that reminds the viewer what the numbers mean.
const statHint = (statistic) => {
  if (statistic === 'median') return 'median';
  if (statistic === 'average') return 'average';
  return 'median (avg)';
};

const CycleTable = ({ result, statistic, groupHeader }) => {
  const head = {
    cells: [
      { key: 'label', content: groupHeader, isSortable: true },
      { key: 'n', content: 'Issues', isSortable: true },
      { key: 'wait', content: `Wait (${statHint(statistic)})`, isSortable: true },
      { key: 'exec', content: `Execution (${statHint(statistic)})`, isSortable: true },
      { key: 'total', content: `Total (${statHint(statistic)})`, isSortable: true },
    ],
  };

  // Sort keys for duration columns use the median so the table sorts on the
  // headline number regardless of which statistic is displayed.
  const metricCell = (metric, key) => ({
    key,
    content: <MetricCell metric={metric} statistic={statistic} />,
  });

  const dataRow = (r) => ({
    key: r.key,
    cells: [
      { key: 'label', content: r.label },
      { key: 'n', content: String(r.n) },
      metricCell(r.wait, 'wait'),
      metricCell(r.exec, 'exec'),
      metricCell(r.total, 'total'),
    ],
  });

  // Team-overall as a pinned summary row at the top, visually flagged.
  const overallRow = {
    key: result.overall.key,
    cells: [
      { key: 'label', content: <Strong>{result.overall.label}</Strong> },
      { key: 'n', content: <Strong>{String(result.overall.n)}</Strong> },
      metricCell(result.overall.wait, 'wait'),
      metricCell(result.overall.exec, 'exec'),
      metricCell(result.overall.total, 'total'),
    ],
  };

  return (
    <DynamicTable
      head={head}
      rows={[overallRow, ...result.rows.map(dataRow)]}
      rowsPerPage={result.rows.length > 12 ? 12 : undefined}
      emptyView="No resolved issues with SLA data in this window."
    />
  );
};

// ---------------------------------------------------------------------------
// COMPLIANCE VIEW — per group, a met-vs-breached bar + breach rate per SLA
// ---------------------------------------------------------------------------

// A proportional met (green) vs breached (red) bar for one SLA, with the raw
// "met/total" count beside it. Built without flex (xcss has no display:flex): a
// red container with a single green Box overlaid from the left at the met share,
// so the remaining red reads as breached. No completed cycles → a muted dash (not
// an empty bar), so "no data" reads differently from "all met". The split uses the
// same rounded breach % the rate lozenge shows, so bar and number always agree.
const ComplianceBar = ({ stat }) => {
  const total = stat.cycles;
  if (!total) return <Text color="color.text.subtlest">—</Text>;
  const breachedPct = Math.round((stat.breached / total) * 100);
  const metPct = 100 - breachedPct;
  return (
    <Inline space="space.100" alignBlock="center">
      <Box
        xcss={{
          width: '110px',
          height: '12px',
          borderRadius: 'border.radius.100',
          overflow: 'hidden',
          backgroundColor: 'color.background.danger.bold',
        }}
      >
        <Box
          xcss={{
            width: `${metPct}%`,
            height: '12px',
            backgroundColor: 'color.background.success.bold',
          }}
        />
      </Box>
      <Text size="small" color="color.text.subtlest">
        {stat.met}/{total}
      </Text>
    </Inline>
  );
};

// Breach rate as a lozenge: success (green) when nothing breached, removed (red)
// when any cycle breached; a muted dash when there were no cycles to rate. When a
// drill-down `href` is supplied and there are breaches to look at, the lozenge
// becomes a link to the matching issues (opens the Jira issue navigator).
const RateLozenge = ({ stat, href }) => {
  if (!stat.cycles) return <Text color="color.text.subtlest">—</Text>;
  const lozenge = (
    <Lozenge appearance={stat.breached > 0 ? 'removed' : 'success'}>
      {formatRate(stat.breached, stat.cycles)}
    </Lozenge>
  );
  if (href && stat.breached > 0) {
    return (
      <Link href={href} openNewTab>
        {lozenge}
      </Link>
    );
  }
  return lozenge;
};

const ComplianceTable = ({ result, groupHeader, linkCtx }) => {
  const head = {
    cells: [
      { key: 'label', content: groupHeader, isSortable: true },
      { key: 'fr', content: 'First Response (met/total)' },
      { key: 'frRate', content: 'FR breach %', isSortable: true },
      { key: 'ttr', content: 'Time to Resolution (met/total)' },
      { key: 'ttrRate', content: 'TTR breach %', isSortable: true },
    ],
  };

  // DynamicTable sorts by each cell's `key` (not its content), so the bar/lozenge
  // cells carry their numeric rate as the key to sort by breach proportion. The
  // label key is the label string so that column sorts alphabetically.
  const dataRow = (r, bold = false) => {
    const fr = r.compliance.firstResponse;
    const ttr = r.compliance.resolution;
    const label = bold ? <Strong>{r.label}</Strong> : r.label;
    // Per-cell drill-down to the matching breached issues. Returns null (plain
    // lozenge) for the request-type dimension or when no base URL is available.
    const frHref = breachLink({ ...linkCtx, row: r, slaFieldId: linkCtx.slaFields.firstResponse });
    const ttrHref = breachLink({ ...linkCtx, row: r, slaFieldId: linkCtx.slaFields.resolution });
    return {
      key: r.key,
      cells: [
        { key: r.label, content: label },
        { key: fr.rate, content: <ComplianceBar stat={fr} /> },
        { key: fr.rate, content: <RateLozenge stat={fr} href={frHref} /> },
        { key: ttr.rate, content: <ComplianceBar stat={ttr} /> },
        { key: ttr.rate, content: <RateLozenge stat={ttr} href={ttrHref} /> },
      ],
    };
  };

  // Default order for the compliance view = worst resolution breach rate first
  // (then most cycles), since aggregate() sorts by duration, which is irrelevant
  // here. Viewers can re-sort any column. Team-overall stays pinned on top.
  const sortedRows = [...result.rows].sort(
    (a, b) =>
      b.compliance.resolution.rate - a.compliance.resolution.rate ||
      b.compliance.resolution.cycles - a.compliance.resolution.cycles,
  );

  return (
    <DynamicTable
      head={head}
      rows={[dataRow(result.overall, true), ...sortedRows.map((r) => dataRow(r))]}
      rowsPerPage={result.rows.length > 12 ? 12 : undefined}
      emptyView="No resolved issues with SLA data in this window."
    />
  );
};

const View = () => {
  const config = useConfig() || {};
  const cfg = normalizeConfig(config);
  const [state, setState] = useState({ loading: true });
  // The grouping/metric selectors start at the configured defaults but are then
  // driven locally — switching either re-renders from the already-fetched records
  // instantly (compliance + durations are both precomputed by aggregate()).
  const [dimension, setDimension] = useState(cfg.grouping);
  const [metric, setMetric] = useState(cfg.metric);

  // Re-fetch only when the saved config changes (filter/window affect the query).
  // The grouping/statistic are applied client-side, so they don't refetch.
  const configKey = JSON.stringify(config);

  useEffect(() => {
    let active = true;
    setState({ loading: true });
    setDimension(cfg.grouping);
    setMetric(cfg.metric);
    invoke('getCycleTime', { config })
      .then((res) => active && setState({ loading: false, res }))
      .catch(
        (err) =>
          active && setState({ loading: false, res: { ok: false, error: String(err) } }),
      );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  const { loading, res } = state;

  // Cheap: re-group the fetched records whenever the dimension or data changes.
  const result = useMemo(() => {
    if (!res || !res.ok) return null;
    return aggregate(res.records, dimension);
  }, [res, dimension]);

  const groupOptions = GROUPINGS.map((g) => ({ label: g.label, value: g.key }));
  const selectedOption =
    groupOptions.find((o) => o.value === dimension) || groupOptions[0];

  const viewOptions = VIEWS.map((v) => ({ label: v.label, value: v.key }));
  const selectedView = viewOptions.find((o) => o.value === metric) || viewOptions[0];

  return (
    <Stack space="space.200">
      {loading && (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="medium" />
          <Text>Loading cycle times…</Text>
        </Inline>
      )}

      {!loading && res && !res.ok && (
        <SectionMessage title="Couldn't load cycle times" appearance="error">
          <Text>{res.error || 'Unknown error.'}</Text>
        </SectionMessage>
      )}

      {!loading && res && res.ok && res.records.length === 0 && (
        <SectionMessage title="No SLA data" appearance="information">
          <Text>
            No resolved issues with completed SLA cycles in this window. Check the
            source filter and window, or that the issues carry the First Response
            and Time to Resolution SLAs.
          </Text>
        </SectionMessage>
      )}

      {!loading && result && res.records.length > 0 && (
        <Stack space="space.150">
          <Inline space="space.200" alignBlock="end" spread="space-between">
            <Inline space="space.150" alignBlock="end">
              <Box xcss={{ minWidth: '200px' }}>
                <Label labelFor="metric-select">View</Label>
                <Select
                  id="metric-select"
                  appearance="default"
                  spacing="compact"
                  options={viewOptions}
                  value={selectedView}
                  onChange={(opt) => opt && setMetric(opt.value)}
                />
              </Box>
              <Box xcss={{ minWidth: '200px' }}>
                <Label labelFor="grouping-select">Group by</Label>
                <Select
                  id="grouping-select"
                  appearance="default"
                  spacing="compact"
                  options={groupOptions}
                  value={selectedOption}
                  onChange={(opt) => opt && setDimension(opt.value)}
                />
              </Box>
            </Inline>
            <Lozenge appearance="inprogress">
              {result.overall.n} issues · {res.scanned} scanned
            </Lozenge>
          </Inline>

          {metric === 'compliance' ? (
            <>
              <ComplianceTable
                result={result}
                groupHeader={groupingLabel(dimension)}
                linkCtx={{
                  baseUrl: res.baseUrl,
                  jql: res.jql,
                  slaFields: res.slaFields,
                  dimension,
                }}
              />
              <Text size="small" color="color.text.subtlest">
                Met (green) vs breached (red) completed SLA cycles · First Response
                + Time to Resolution. Counts each completed cycle, so a reopened
                ticket's repeated SLA runs each count. Completed work only. Click a
                red breach % (by assignee or priority) to open those issues in Jira.
              </Text>
            </>
          ) : (
            <>
              <CycleTable
                result={result}
                statistic={cfg.statistic}
                groupHeader={groupingLabel(dimension)}
              />
              <Text size="small" color="color.text.subtlest">
                Wait = First Response SLA · Execution = Time to Resolution SLA ·
                Total = ready → resolved. Durations are business-hours-aware.
              </Text>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
};

// ---------------------------------------------------------------------------
// EDIT — config form (source filter, default grouping, statistic, window)
// ---------------------------------------------------------------------------

const SelectField = ({ name, label, options, register, defaultValue, helper }) => (
  <Box paddingBlock="space.050">
    <Label labelFor={name}>{label}</Label>
    <Select
      {...register(name)}
      options={options}
      defaultValue={options.find((o) => o.value === defaultValue) || options[0]}
    />
    {helper && <HelperMessage>{helper}</HelperMessage>}
  </Box>
);

const Edit = () => {
  const config = useConfig() || {};
  const cfg = normalizeConfig(config);
  // Defaults first, saved config on top, so the form opens pre-filled and the
  // gadget works out of the box.
  const { handleSubmit, register, getFieldId, formState } = useForm({
    defaultValues: { ...defaultFlatConfig(), ...config },
  });
  const { errors } = formState;

  const onSubmit = (data) => {
    // Select fields can hand back { label, value } objects; flatten to the value
    // string so the saved config stays simple flat strings.
    const flat = { ...data };
    ['grouping', 'metric', 'statistic'].forEach((k) => {
      if (flat[k] && typeof flat[k] === 'object') flat[k] = flat[k].value;
    });
    view.submit(flat);
  };

  const groupOptions = GROUPINGS.map((g) => ({ label: g.label, value: g.key }));
  const viewOptions = VIEWS.map((v) => ({ label: v.label, value: v.key }));
  const statOptions = STATISTICS.map((s) => ({ label: s.label, value: s.key }));

  // Window must be a positive integer when provided (blank = use filter as-is).
  const validateWindow = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return true;
    const n = parseInt(v, 10);
    return (Number.isInteger(n) && n > 0) || 'Enter a whole number of days > 0, or leave blank';
  };

  return (
    <Form onSubmit={handleSubmit(onSubmit)}>
      <FormSection>
        <Heading size="small">Source</Heading>
        <Box paddingBlock="space.050">
          <Label labelFor={getFieldId('filterId')}>Source filter id</Label>
          <Textfield {...register('filterId')} />
          <HelperMessage>
            Jira filter the gadget reads. Leave blank to use the
            CYCLE_TIME_FILTER_ID configured for the app.
          </HelperMessage>
        </Box>
        <Box paddingBlock="space.050">
          <Label labelFor={getFieldId('windowDays')}>Window (days)</Label>
          <Textfield
            type="number"
            {...register('windowDays', { validate: validateWindow })}
          />
          {errors.windowDays && (
            <ErrorMessage>{errors.windowDays.message}</ErrorMessage>
          )}
          <HelperMessage>
            Optional. Tightens the query with `resolved &gt;= -Nd`. Leave blank to
            use the filter&apos;s own window (the default filter is already last 60 days).
          </HelperMessage>
        </Box>
      </FormSection>

      <FormSection>
        <Heading size="small">Display</Heading>
        <SelectField
          name="metric"
          label="Default view"
          options={viewOptions}
          register={register}
          defaultValue={cfg.metric}
          helper="Durations (Wait/Execution/Total) or SLA met vs breached. Viewers can switch it on the panel."
        />
        <SelectField
          name="grouping"
          label="Default grouping"
          options={groupOptions}
          register={register}
          defaultValue={cfg.grouping}
          helper="The dimension shown first. Viewers can still switch it on the panel."
        />
        <SelectField
          name="statistic"
          label="Statistic (durations view)"
          options={statOptions}
          register={register}
          defaultValue={cfg.statistic}
          helper="Median is the headline (durations are right-skewed); average for context."
        />
      </FormSection>

      <FormFooter>
        <Button appearance="primary" type="submit">
          Save
        </Button>
      </FormFooter>
    </Form>
  );
};

// ---------------------------------------------------------------------------

const App = () => {
  const context = useProductContext();
  if (!context) return <Text>Loading…</Text>;
  return context.extension.entryPoint === 'edit' ? <Edit /> : <View />;
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
