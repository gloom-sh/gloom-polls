import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities, type InputRenderable } from "gloomberb/ui";
import { usePluginPaneState, useShortcut } from "gloomberb/react";
import { isPlainArrowUp, stopSearchFocusNavigation } from "gloomberb/utils";
import {
  DataTableStackView,
  DataTableView,
  EmptyState,
  PaneStatusBody,
  QueryBar,
  SectionHeading,
  StatGrid,
  Tabs,
  usePaneFooter,
  usePaneHeaderTabs,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type StatItem,
} from "gloomberb/components";
import {
  CompositeChart,
  pricePointsToResolvedSeries,
} from "gloomberb/components";
import { colors } from "gloomberb/theme";
import { isPlainKey } from "gloomberb/utils";
import { openUrl } from "gloomberb/components";
import type { PricePoint } from "gloomberb/types/financials";
import type { PaneProps } from "gloomberb/types/plugin";
import { nextStackSortPreference } from "./hooks";
import { useAutoRefresh, useUpdatedAgo } from "gloomberb/react";
import { fetchVoteHubPolls } from "./client";
import {
  choiceTone,
  clipText,
  computeMovingAverage,
  computePollAverages,
  computePollsterAverages,
  computePollTrend,
  DEFAULT_POLL_SORT,
  filterPollRows,
  formatPollDate,
  normalizeVoteHubPoll,
  shortChoice,
  sortPollRows,
  type PollSortColumnId,
  type PollSortPreference,
} from "./normalize";
import type { PollDetailTab, PollRow, PollsterAverage, PollTabId } from "./types";

type LoadStatus = "loading" | "loaded" | "error";

interface PollColumn extends DataTableColumn {
  id: "date" | "subject" | "pollster" | "pop" | "result";
}

interface PollsterColumn extends DataTableColumn {
  id: "pollster" | "avg" | "sample" | "count" | "bar";
}

const TABS: Array<{ value: PollTabId; label: string }> = [
  { value: "approval", label: "Approval" },
  { value: "favorability", label: "Favorability" },
  { value: "generic-ballot", label: "Generic" },
  { value: "us-senator", label: "Senate" },
  { value: "governor", label: "Governor" },
  { value: "us-representative", label: "House" },
];

const DETAIL_TABS: Array<{ value: PollDetailTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "trend", label: "Trend" },
  { value: "pollsters", label: "Pollsters" },
];

const TREND_WINDOW = 5;
const RECENT_POLL_COUNT = 10;

function answerChoiceColor(choice: string): string | undefined {
  const tone = choiceTone(choice);
  if (tone === "positive") return colors.positive;
  if (tone === "negative") return colors.negative;
  return undefined;
}

function isPollTab(value: unknown): value is PollTabId {
  return TABS.some((tab) => tab.value === value);
}

function longest(values: string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function createColumns(width: number, rows: PollRow[]): PollColumn[] {
  const dateWidth = 6;
  const popWidth = 6;
  // Sized to what the category holds, so both answers and both percentages of
  // a result fit and the pollster, the one long free-text column, takes the rest.
  const subjectWidth = Math.min(26, Math.max(8, longest(rows.map((row) => row.subject))));
  const resultWidth = Math.min(36, Math.max(12, longest(rows.map((row) => row.result))));
  const fixed = 2 + dateWidth + 1 + subjectWidth + 1 + resultWidth + 1;
  const showPop = width - fixed >= 14 + 1 + 8 + 1;
  return [
    { id: "date", label: "DATE", width: dateWidth, align: "left" },
    { id: "subject", label: "SUBJECT", width: subjectWidth, align: "left" },
    { id: "pollster", label: "POLLSTER", width: 14, align: "left", flexGrow: 1 },
    ...(showPop ? [{ id: "pop" as const, label: "SAMPLE", width: popWidth, align: "left" as const }] : []),
    { id: "result", label: "RESULT", width: resultWidth, align: "left" },
  ];
}

function renderPollCell(row: PollRow, column: PollColumn, selected: boolean): DataTableCell {
  const sel = selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "date":
      return { text: formatPollDate(row.endDate), color: sel ?? colors.textDim };
    case "subject":
      return { text: row.subject, color: sel ?? colors.textBright, attributes: TextAttributes.BOLD };
    case "pollster":
      return { text: row.pollster, color: sel ?? colors.textMuted };
    case "pop":
      return { text: row.population, color: sel ?? colors.textDim };
    case "result":
      // The leader's own tone: a leading "Disapprove" reads negative, a
      // candidate neutral. The margin is always positive, so it cannot color.
      return {
        text: row.result,
        color: sel ?? (row.leadChoice ? answerChoiceColor(row.leadChoice) : undefined) ?? colors.text,
      };
  }
}

/**
 * A share of the largest value as a length. The terminal fills cells with the
 * colour; the desktop draws a thin rounded bar inside the row.
 */
function AnswerBar({ pct, color, maxPct, width }: { pct: number; color: string; maxPct: number; width: number }) {
  const { nativePaneChrome } = useUiCapabilities();
  const ratio = maxPct > 0 ? Math.min(1, Math.max(0, pct / maxPct)) : 0;
  if (nativePaneChrome) {
    return (
      <Box flexGrow={1} height={1} flexDirection="row" alignItems="center" overflow="hidden" style={{ width: "100%" }}>
        <Box
          backgroundColor={color}
          style={{ width: `${(ratio * 100).toFixed(2)}%`, height: "9px", borderRadius: "2px", minWidth: ratio > 0 ? "2px" : "0" }}
        />
      </Box>
    );
  }
  const barWidth = ratio > 0 ? Math.max(1, Math.round(ratio * width)) : 0;
  return (
    <Box flexDirection="row" height={1} gap={1}>
      <Box width={barWidth} backgroundColor={color} />
      <Box flexGrow={1} />
    </Box>
  );
}

function pollStatItems(poll: PollRow): StatItem[] {
  const start = formatPollDate(poll.startDate);
  const end = formatPollDate(poll.endDate);
  const sponsors = poll.sponsors.join(", ");
  return [
    { id: "field", label: "Fielded", value: start === end ? end : `${start} to ${end}` },
    { id: "pollster", label: "Pollster", value: poll.pollster, wide: poll.pollster.length > 28 },
    poll.sampleSize != null
      ? { id: "sample", label: "Sample", value: poll.sampleSize.toLocaleString("en-US"), detail: poll.population }
      : { id: "sample", label: "Sample", value: poll.population },
    ...(poll.marginOfError != null ? [{ id: "moe", label: "MoE", value: `±${poll.marginOfError}%` }] : []),
    ...(sponsors ? [{ id: "sponsor", label: "Sponsor", value: sponsors, wide: sponsors.length > 28 }] : []),
    ...(poll.partisan ? [{ id: "partisan", label: "Partisan", value: poll.partisan }] : []),
    ...(poll.internal ? [{ id: "internal", label: "Internal", value: "Yes" }] : []),
  ];
}

function AnswerRow({
  label,
  value,
  pct,
  maxPct,
  color,
  labelColor,
  valueColor,
  labelWidth,
  barWidth,
  trailing,
}: {
  label: string;
  value: string;
  pct: number;
  maxPct: number;
  color: string;
  labelColor: string;
  valueColor: string;
  labelWidth: number;
  barWidth: number;
  trailing?: string;
}) {
  return (
    <Box flexDirection="row" height={1} gap={2}>
      <Box width={labelWidth} flexShrink={0} overflow="hidden">
        <Text fg={labelColor}>{clipText(label, labelWidth)}</Text>
      </Box>
      <Box width={4} flexShrink={0} justifyContent="flex-end" flexDirection="row">
        <Text fg={valueColor} attributes={TextAttributes.BOLD}>{value}</Text>
      </Box>
      <Box width={barWidth} flexShrink={0}>
        <AnswerBar pct={pct} color={color} maxPct={maxPct} width={barWidth} />
      </Box>
      {trailing != null ? <Text fg={colors.textDim}>{trailing}</Text> : null}
    </Box>
  );
}

function PollOverview({ poll, allRows, width }: { poll: PollRow; allRows: PollRow[]; width: number }) {
  const { nativePaneChrome } = useUiCapabilities();
  const lineWidth = Math.max(12, width - 2);
  const maxPct = Math.max(...poll.answers.map((a) => a.pct), 1);
  const labelWidth = Math.min(16, Math.floor(lineWidth * 0.35));
  const barWidth = Math.max(10, lineWidth - labelWidth - 12);
  // Terminal bars fill whole cells, so a blank row keeps neighbours apart; the
  // desktop bar is thinner than its row.
  const rowGap = nativePaneChrome ? 0 : 1;

  const averages = useMemo(
    () => computePollAverages(allRows, poll.subject, RECENT_POLL_COUNT),
    [allRows, poll.subject],
  );
  const maxAvg = Math.max(...averages.map((a) => a.avgPct), 1);
  const stats = useMemo(() => pollStatItems(poll), [poll]);

  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
      <StatGrid items={stats} width={width} />
      <ScrollBox flexGrow={1} flexBasis={0} minHeight={0} scrollY>
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          <SectionHeading title="This poll" />
          <Box flexDirection="column" gap={rowGap} marginTop={rowGap}>
            {poll.answers.map((answer) => {
              const choiceColor = answerChoiceColor(answer.choice);
              const leading = poll.leadChoice === answer.choice;
              return (
                <AnswerRow
                  key={answer.choice}
                  label={answer.choice}
                  value={Number.isInteger(answer.pct) ? `${answer.pct}` : answer.pct.toFixed(1)}
                  pct={answer.pct}
                  maxPct={maxPct}
                  color={choiceColor ?? (leading ? colors.positive : colors.border)}
                  labelColor={choiceColor ?? colors.text}
                  valueColor={choiceColor ?? (leading ? colors.textBright : colors.textDim)}
                  labelWidth={labelWidth}
                  barWidth={barWidth}
                />
              );
            })}
          </Box>

          {averages.length > 0 && (
            <>
              <SectionHeading title={`${RECENT_POLL_COUNT}-poll weighted avg`} marginTop={1} />
              <Box flexDirection="column" gap={rowGap} marginTop={rowGap}>
                {averages.map((avg) => {
                  const avgColor = answerChoiceColor(avg.choice);
                  return (
                    <AnswerRow
                      key={avg.choice}
                      label={avg.choice}
                      value={avg.avgPct.toFixed(1)}
                      pct={avg.avgPct}
                      maxPct={maxAvg}
                      color={avgColor ?? colors.textBright}
                      labelColor={avgColor ?? colors.text}
                      valueColor={avgColor ?? colors.textBright}
                      labelWidth={labelWidth}
                      barWidth={barWidth}
                      trailing={String(avg.pollCount)}
                    />
                  );
                })}
              </Box>
            </>
          )}
        </Box>
      </ScrollBox>
    </Box>
  );
}

function PollTrend({
  poll,
  allRows,
  width,
  height,
}: {
  poll: PollRow;
  allRows: PollRow[];
  width: number;
  height: number;
}) {
  const leadingChoice = poll.leadChoice ?? poll.answers[0]?.choice ?? null;

  const trendData = useMemo(() => {
    if (!leadingChoice) return { points: [], ma: [] };
    const points = computePollTrend(allRows, poll.subject, leadingChoice);
    const ma = computeMovingAverage(points, TREND_WINDOW);
    return { points, ma };
  }, [allRows, poll.subject, leadingChoice]);

  if (!leadingChoice || trendData.points.length === 0) {
    return <EmptyState title="No trend data." hint="Not enough polls for this subject." />;
  }

  if (trendData.points.length < 2) {
    return <EmptyState title="Not enough data for a trend." hint="Need at least 2 polls." />;
  }

  const rawPoints: PricePoint[] = trendData.points.map((p) => ({
    date: new Date(`${p.date}T00:00:00Z`),
    close: p.value,
  }));

  const maPoints: PricePoint[] = trendData.ma.map((p) => ({
    date: new Date(`${p.date}T00:00:00Z`),
    close: p.value,
  }));

  const rawSeries = pricePointsToResolvedSeries(rawPoints, {
    id: "raw",
    label: leadingChoice,
    color: colors.textDim,
    unit: "%",
    unitGroup: "percent",
    style: "points",
    axis: "left",
    panelId: "pct",
  });

  // The average takes the leading answer's tone, as the pollster bars do, so a
  // disapproval trend does not read as good news.
  const maSeries = maPoints.length > 0
    ? pricePointsToResolvedSeries(maPoints, {
        id: "ma",
        label: `${TREND_WINDOW}-poll avg`,
        color: answerChoiceColor(leadingChoice) ?? colors.positive,
        unit: "%",
        unitGroup: "percent",
        style: "line",
        axis: "left",
        panelId: "pct",
      })
    : null;

  const series = maSeries ? [rawSeries, maSeries] : [rawSeries];

  // The legend names the choice and the time axis spans the polls, so the
  // chart needs no caption line above it.
  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden" paddingX={1}>
      <CompositeChart
        width={Math.max(1, width - 2)}
        height={Math.max(height, 4)}
        focused={false}
        interactive={false}
        series={series}
        panels={[{ id: "pct", scale: "linear" }]}
        axisWidth={8}
        showLegend={true}
        showTimeAxis={true}
        formatValue={(value: number) => `${value.toFixed(1)}%`}
      />
    </Box>
  );
}

function createPollsterColumns(width: number, pollsters: PollsterAverage[], choiceLabel: string): PollsterColumn[] {
  const avgWidth = Math.max(6, choiceLabel.length + 2);
  const sampleWidth = 8;
  const countWidth = 7;
  const barWidth = 10;
  const room = width - 2 - (avgWidth + 1) - (sampleWidth + 1) - (countWidth + 1) - (barWidth + 1) - 2;
  const pollsterWidth = Math.max(12, Math.min(32, room, longest(pollsters.map((entry) => entry.pollster))));
  return [
    { id: "pollster", label: "POLLSTER", width: pollsterWidth, align: "left" },
    { id: "avg", label: choiceLabel, width: avgWidth, align: "right" },
    { id: "sample", label: "SAMPLE", width: sampleWidth, align: "right" },
    { id: "count", label: "POLLS", width: countWidth, align: "right" },
    { id: "bar", label: "", width: barWidth, align: "left", flexGrow: 1 },
  ];
}

function PollPollsters({
  poll,
  allRows,
  width,
  height,
  focused,
}: {
  poll: PollRow;
  allRows: PollRow[];
  width: number;
  height: number;
  focused: boolean;
}) {
  const leadingChoice = poll.leadChoice ?? poll.answers[0]?.choice ?? null;
  const pollsters = useMemo(
    () => computePollsterAverages(allRows, poll.subject, leadingChoice),
    [allRows, poll.subject, leadingChoice],
  );
  // The average is of the leading answer; its name heads the column.
  const choiceLabel = leadingChoice ? shortChoice(leadingChoice, poll.pollType) : "Avg";
  const columns = useMemo(
    () => createPollsterColumns(width, pollsters, choiceLabel),
    [choiceLabel, pollsters, width],
  );
  const maxAvg = Math.max(...pollsters.map((p) => p.avgPct), 1);
  const barColor = (leadingChoice ? answerChoiceColor(leadingChoice) : undefined) ?? colors.positive;

  if (pollsters.length === 0) {
    return <EmptyState title="No pollster data." hint="Not enough polls for this subject." />;
  }

  return (
    <DataTableView<PollsterAverage, PollsterColumn>
      focused={focused}
      selection={{ kind: "none" }}
      rootWidth={width}
      rootHeight={Math.max(1, height)}
      columns={columns}
      items={pollsters}
      sortColumnId={null}
      sortDirection="desc"
      getItemKey={(entry) => entry.pollster}
      renderCell={(entry, column) => {
        switch (column.id) {
          case "pollster":
            return { text: entry.pollster, color: colors.text };
          case "avg":
            return { text: entry.avgPct.toFixed(1), color: colors.textBright, attributes: TextAttributes.BOLD };
          case "sample":
            return { text: entry.totalSample > 0 ? entry.totalSample.toLocaleString("en-US") : "—", color: colors.textDim };
          case "count":
            return { text: String(entry.count), color: colors.textDim };
          case "bar":
            return {
              text: "",
              content: <AnswerBar pct={entry.avgPct} color={barColor} maxPct={maxAvg} width={column.width} />,
            };
        }
      }}
      emptyStateTitle="No pollster data."
    />
  );
}

function PollDetail({
  poll,
  allRows,
  width,
  height,
  focused,
  detailTab,
  onDetailTabChange,
}: {
  poll: PollRow;
  allRows: PollRow[];
  width: number;
  height: number;
  focused: boolean;
  detailTab: PollDetailTab;
  onDetailTabChange: (tab: PollDetailTab) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  // The desktop switches views from a query bar that takes the place of the
  // stack's Back row; the terminal keeps its tab row and the blank row under it.
  // The host hands that row only to a bar that mounts after the detail
  // container is attached, so the bar waits for the detail's first commit.
  const [barMounted, setBarMounted] = useState(false);
  useEffect(() => setBarMounted(true), []);
  const header = nativePaneChrome ? (
    barMounted ? (
      <QueryBar
        width={width}
        view={{ value: detailTab, options: DETAIL_TABS, onChange: onDetailTabChange }}
      />
    ) : null
  ) : (
    <Box paddingBottom={1}>
      <Tabs
        tabs={DETAIL_TABS}
        activeValue={detailTab}
        onSelect={(v) => onDetailTabChange(v as PollDetailTab)}
        compact
      />
    </Box>
  );
  const contentHeight = Math.max(height - (nativePaneChrome ? 0 : 2), 1);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {header}
      {detailTab === "trend" ? (
        <PollTrend poll={poll} allRows={allRows} width={width} height={contentHeight} />
      ) : detailTab === "pollsters" ? (
        <PollPollsters poll={poll} allRows={allRows} width={width} height={contentHeight} focused={focused} />
      ) : (
        <PollOverview poll={poll} allRows={allRows} width={width} />
      )}
    </Box>
  );
}

export function PollsPane({ focused, width, height }: PaneProps) {
  const [storedTab, setTab] = usePluginPaneState<PollTabId>("tab", "approval");
  const tab: PollTabId = isPollTab(storedTab) ? storedTab : "approval";
  const [rowsByTab, setRowsByTab] = useState<Partial<Record<PollTabId, PollRow[]>>>({});
  // The mount effect loads immediately, so the first paint is a spinner rather
  // than a premature "No polls in this category".
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<PollDetailTab>("overview");
  const [sortPreference, setSortPreference] = useState<PollSortPreference>(DEFAULT_POLL_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const genRef = useRef(0);

  const allRows = rowsByTab[tab] ?? [];
  const filteredRows = useMemo(() => filterPollRows(allRows, searchQuery), [allRows, searchQuery]);
  const rows = useMemo(() => sortPollRows(filteredRows, sortPreference), [filteredRows, sortPreference]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => {
    setSearchFocused(false);
  }, []);

  const load = useCallback((pollType: PollTabId) => {
    genRef.current += 1;
    const gen = genRef.current;
    setStatus("loading");
    setError(null);
    fetchVoteHubPolls({ pollType })
      .then((polls) => {
        if (genRef.current !== gen) return;
        setRowsByTab((current) => ({
          ...current,
          [pollType]: polls.map(normalizeVoteHubPoll),
        }));
        setStatus("loaded");
        setLastUpdated(Date.now());
      })
      .catch((loadError) => {
        if (genRef.current !== gen) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    load(tab);
  }, [load, tab]);

  const refreshActiveTab = useCallback(() => {
    load(tab);
  }, [load, tab]);
  useAutoRefresh(status === "loaded" ? lastUpdated : null, refreshActiveTab);

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      setDetailOpen(false);
      return;
    }
    if (!selectedId || !rows.some((row) => row.id === selectedId)) {
      setSelectedId(rows[0]!.id);
    }
  }, [rows, selectedId]);

  const openSelected = useCallback(() => {
    if (!selected?.url) return;
    openUrl(selected.url);
  }, [selected]);

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    if (event.name === "/") {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
      return true;
    }
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      load(tab);
      return true;
    }
    if (isPlainKey(event, "o")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (selected?.url) openUrl(selected.url);
      return true;
    }
    return false;
  }, [focusSearch, load, openSelected, selected?.url, tab]);

  useShortcut((event) => {
    if (!focused || detailOpen || searchFocused) return;
    if (event.name === "/") {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
    }
  }, { enabled: focused && !detailOpen && !searchFocused });

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "h") || event.name === "left") {
      event.preventDefault?.();
      event.stopPropagation?.();
      setDetailTab((current) => {
        const idx = DETAIL_TABS.findIndex((t) => t.value === current);
        if (idx <= 0) return DETAIL_TABS[DETAIL_TABS.length - 1]!.value;
        return DETAIL_TABS[idx - 1]!.value;
      });
      return true;
    }
    if (isPlainKey(event, "l") || event.name === "right") {
      event.preventDefault?.();
      event.stopPropagation?.();
      setDetailTab((current) => {
        const idx = DETAIL_TABS.findIndex((t) => t.value === current);
        if (idx < 0 || idx >= DETAIL_TABS.length - 1) return DETAIL_TABS[0]!.value;
        return DETAIL_TABS[idx + 1]!.value;
      });
      return true;
    }
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      load(tab);
      return true;
    }
    if (isPlainKey(event, "o")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (selected?.url) openUrl(selected.url);
      return true;
    }
    return false;
  }, [load, selected?.url, tab]);

  const columns = useMemo(() => createColumns(width, allRows), [allRows, width]);
  const updatedAgo = useUpdatedAgo(status === "loaded" ? lastUpdated : null);
  const renderCell = useCallback(
    (row: PollRow, column: PollColumn, _index: number, rowState: { selected: boolean }) =>
      renderPollCell(row, column, rowState.selected),
    [],
  );

  usePaneFooter("polls", () => ({
    info: [
      ...(status === "loading" ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(error ? [{ id: "error", parts: [{ text: "error", tone: "warning" as const }] }] : []),
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: `updated ${updatedAgo}`, tone: "muted" as const }] }] : []),
    ],
    hints: detailOpen
      ? [{ id: "open", key: "o", label: "pen", onPress: openSelected, disabled: !selected?.url }]
      : [
          { id: "search", key: "/", label: "search", onPress: focusSearch },
          { id: "open", key: "o", label: "pen", onPress: openSelected, disabled: !selected?.url },
        ],
  }), [error, detailOpen, focusSearch, openSelected, selected?.url, status, updatedAgo]);

  const selectTab = (value: string) => {
    setTab(value as PollTabId);
    setDetailOpen(false);
    setSearchQuery("");
  };
  const tabsFocused = focused && !detailOpen && !searchFocused;
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: selectTab, focused: tabsFocused });
  const tabsHeight = tabsInHeader ? 0 : 1;

  const tabs = tabsInHeader ? null : (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Tabs
        tabs={TABS}
        activeValue={tab}
        onSelect={selectTab}
        compact
        variant="bare"
        focused={tabsFocused}
      />
    </Box>
  );

  const searchBar = (
    <QueryBar
      width={width}
      search={{
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: "subject or pollster",
        focused: focused && !detailOpen,
        active: searchFocused,
        onActiveChange: (active) => (active ? setSearchFocused(true) : blurSearch()),
        focusToken: searchFocusToken,
        inputRef: searchInputRef,
        debounceMs: 80,
      }}
    />
  );

  if (allRows.length === 0 && (status === "loading" || error)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody loading={status === "loading"} error={error} subject="Polls" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableStackView<PollRow, PollColumn>
        focused={focused && !searchFocused}
        detailOpen={detailOpen && !!selected}
        onBack={() => setDetailOpen(false)}
        detailContent={
          selected ? (
            <PollDetail
              poll={selected}
              allRows={allRows}
              width={width}
              height={Math.max(height - tabsHeight - 1, 1)}
              focused={focused}
              detailTab={detailTab}
              onDetailTabChange={setDetailTab}
            />
          ) : null
        }
        detailTitle={selected?.subject}
        rootBefore={searchBar}
        onRootKeyDown={handleRootKeyDown}
        onDetailKeyDown={handleDetailKeyDown}
        selection={{
          kind: "id",
          selectedId,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        onActivate={() => {
          blurSearch();
          setDetailOpen(true);
        }}
        rootWidth={width}
        rootHeight={Math.max(1, height - tabsHeight)}
        columns={columns}
        items={rows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={(columnId) => {
          const next = columnId as PollSortColumnId;
          setSortPreference((current) => nextStackSortPreference(
            current,
            next,
            next === "subject" || next === "pollster" || next === "pop" ? "asc" : "desc",
          ));
        }}
        getItemKey={(row) => row.id}
        renderCell={renderCell}
        emptyStateTitle={searchQuery.trim() ? "No matching polls." : "No polls in this category."}
        emptyStateHint={searchQuery.trim() ? "Clear search." : undefined}
      />
    </Box>
  );
}
