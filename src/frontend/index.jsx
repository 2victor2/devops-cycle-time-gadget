import React, { useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Text,
  Heading,
  Strong,
  Box,
  Stack,
  Inline,
  Lozenge,
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
  defaultFlatConfig,
  normalizeConfig,
  formatDuration,
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

const View = () => {
  const config = useConfig() || {};
  const cfg = normalizeConfig(config);
  const [state, setState] = useState({ loading: true });
  // The grouping selector starts at the configured default but is then driven
  // locally — switching it re-aggregates the already-fetched records instantly.
  const [dimension, setDimension] = useState(cfg.grouping);

  // Re-fetch only when the saved config changes (filter/window affect the query).
  // The grouping/statistic are applied client-side, so they don't refetch.
  const configKey = JSON.stringify(config);

  useEffect(() => {
    let active = true;
    setState({ loading: true });
    setDimension(cfg.grouping);
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
          <Inline space="space.100" alignBlock="center" spread="space-between">
            <Box xcss={{ minWidth: '220px' }}>
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
            <Lozenge appearance="inprogress">
              {result.overall.n} issues · {res.scanned} scanned
            </Lozenge>
          </Inline>
          <CycleTable
            result={result}
            statistic={cfg.statistic}
            groupHeader={groupingLabel(dimension)}
          />
          <Text size="small" color="color.text.subtlest">
            Wait = First Response SLA · Execution = Time to Resolution SLA ·
            Total = ready → resolved. Durations are business-hours-aware.
          </Text>
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
    ['grouping', 'statistic'].forEach((k) => {
      if (flat[k] && typeof flat[k] === 'object') flat[k] = flat[k].value;
    });
    view.submit(flat);
  };

  const groupOptions = GROUPINGS.map((g) => ({ label: g.label, value: g.key }));
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
          name="grouping"
          label="Default grouping"
          options={groupOptions}
          register={register}
          defaultValue={cfg.grouping}
          helper="The dimension shown first. Viewers can still switch it on the panel."
        />
        <SelectField
          name="statistic"
          label="Statistic"
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
