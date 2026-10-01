import { useState } from "react";
import { Activity, Boxes, GitBranch, Hash } from "lucide-react";
import { SectionHeading } from "../page/Page";
import {
  AreaChartCard,
  BarChartCard,
  DataTable,
  DonutCard,
  StatCard,
  StatGrid,
  TabStatus,
  TabToolbar,
  TONE_COLOR,
  WindowPicker,
  type ApiFetch,
  useAdminData,
} from "./shared";
import { formatNumber, shortDate } from "./format";

export interface UsageRow {
  date: string;
  requests: number;
  roots: number;
  continuations: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens?: number;
}

export interface ModelUsage {
  provider_name: string | null;
  model_id: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens?: number;
  percentage?: number;
}

const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);
const modelTokens = (m: ModelUsage) => m.tokens ?? m.prompt_tokens + m.completion_tokens;

export function UsageTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAdminData<UsageRow[]>(
    apiFetch,
    `/api/admin/usage/by-time?days=${days}`,
    refreshKey,
  );

  const toolbar = (
    <TabToolbar>
      <WindowPicker value={days} options={[7, 30, 90, 365]} onChange={setDays} />
    </TabToolbar>
  );
  if (!data) {
    return (
      <div className="space-y-5">
        {toolbar}
        <TabStatus loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  // The API returns newest first; charts read left-to-right in time.
  const chrono = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const chart = chrono.map((r) => ({
    date: shortDate(r.date),
    roots: r.roots,
    continuations: r.continuations,
    prompt: r.prompt_tokens,
    completion: r.completion_tokens,
  }));
  const requests = sum(data, (r) => r.requests);
  const roots = sum(data, (r) => r.roots);
  const continuations = sum(data, (r) => r.continuations);
  const prompt = sum(data, (r) => r.prompt_tokens);
  const completion = sum(data, (r) => r.completion_tokens);

  return (
    <div className="space-y-5">
      {toolbar}
      <StatGrid>
        <StatCard icon={Activity} label="Requests" value={formatNumber(requests)} sub={`${formatNumber(requests / Math.max(1, data.length))} per active day`} />
        <StatCard
          icon={GitBranch}
          label="Turns per task"
          value={roots ? (requests / roots).toFixed(1) : "—"}
          sub={`${formatNumber(roots)} tasks · ${formatNumber(continuations)} follow-up calls`}
          hint="Requests ÷ root requests: how many model calls one user message takes"
        />
        <StatCard icon={Hash} label="Tokens" value={formatNumber(prompt + completion)} sub={`${formatNumber(prompt)} in · ${formatNumber(completion)} out`} />
        <StatCard
          icon={Boxes}
          label="Input share"
          value={prompt + completion ? `${((prompt / (prompt + completion)) * 100).toFixed(0)}%` : "—"}
          sub="of all tokens are prompt"
          hint="High input share means context, not answers, drives cost"
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <BarChartCard
          title="Requests per day"
          sub="tasks vs follow-up calls"
          data={chart}
          xKey="date"
          stacked
          series={[
            { key: "roots", label: "Tasks" },
            { key: "continuations", label: "Follow-ups", color: TONE_COLOR.muted },
          ]}
          valueFormatter={(v) => formatNumber(v)}
        />
        <AreaChartCard
          title="Tokens per day"
          data={chart}
          xKey="date"
          series={[
            { key: "prompt", label: "Prompt" },
            { key: "completion", label: "Completion", color: TONE_COLOR.info },
          ]}
          valueFormatter={(v) => formatNumber(v)}
        />
      </div>

      <div>
        <SectionHeading title="By day" count={data.length} className="mt-2" />
        <DataTable
          rows={data}
          rowKey={(r) => r.date}
          defaultSort={{ key: "date", dir: "desc" }}
          empty="No requests in this window."
          exportName={`usage-${days}d`}
          limit={31}
          columns={[
            { key: "date", label: "Date" },
            { key: "requests", label: "Requests", numeric: true, render: (r) => formatNumber(r.requests) },
            { key: "roots", label: "Tasks", numeric: true, render: (r) => formatNumber(r.roots) },
            { key: "continuations", label: "Follow-ups", numeric: true, render: (r) => formatNumber(r.continuations) },
            { key: "prompt_tokens", label: "Prompt tokens", numeric: true, render: (r) => formatNumber(r.prompt_tokens) },
            { key: "completion_tokens", label: "Completion tokens", numeric: true, render: (r) => formatNumber(r.completion_tokens) },
          ]}
        />
      </div>
    </div>
  );
}

export function ModelsTab({ apiFetch, refreshKey }: { apiFetch: ApiFetch; refreshKey: number }) {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAdminData<ModelUsage[]>(
    apiFetch,
    `/api/admin/usage/by-model?days=${days}`,
    refreshKey,
  );

  const toolbar = (
    <TabToolbar>
      <WindowPicker value={days} options={[7, 30, 90, 365]} onChange={setDays} />
    </TabToolbar>
  );
  if (!data) {
    return (
      <div className="space-y-5">
        {toolbar}
        <TabStatus loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  const total = sum(data, modelTokens);
  const share = (m: ModelUsage) => (total ? modelTokens(m) / total : 0);
  const top = [...data].sort((a, b) => modelTokens(b) - modelTokens(a));
  const donut = [
    ...top.slice(0, 6).map((m) => ({ name: m.model_id, value: modelTokens(m) })),
    ...(top.length > 6 ? [{ name: "other", value: sum(top.slice(6), modelTokens), color: TONE_COLOR.muted }] : []),
  ];
  const byProvider = Object.entries(
    data.reduce<Record<string, number>>((acc, m) => {
      const k = m.provider_name ?? "unknown";
      acc[k] = (acc[k] ?? 0) + m.requests;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .map(([provider, requests]) => ({ provider, requests }));

  return (
    <div className="space-y-5">
      {toolbar}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <DonutCard title="Token share by model" sub={`${formatNumber(total)} tokens`} data={donut} valueFormatter={(v) => formatNumber(v)} />
        <BarChartCard
          title="Requests by provider"
          data={byProvider}
          xKey="provider"
          series={[{ key: "requests", label: "Requests" }]}
          valueFormatter={(v) => formatNumber(v)}
        />
      </div>
      <div>
        <SectionHeading title="Models" count={data.length} className="mt-2" />
        <DataTable
          rows={data}
          rowKey={(m) => `${m.provider_name ?? ""}/${m.model_id}`}
          defaultSort={{ key: "tokens", dir: "desc" }}
          empty="No model usage in this window."
          exportName={`models-${days}d`}
          columns={[
            { key: "model_id", label: "Model", mono: true },
            { key: "provider_name", label: "Provider" },
            { key: "requests", label: "Requests", numeric: true, render: (m) => formatNumber(m.requests) },
            { key: "prompt_tokens", label: "Prompt", numeric: true, render: (m) => formatNumber(m.prompt_tokens) },
            { key: "completion_tokens", label: "Completion", numeric: true, render: (m) => formatNumber(m.completion_tokens) },
            {
              key: "tokens_per_request",
              label: "Tokens / req",
              numeric: true,
              value: (m) => (m.requests ? Math.round(modelTokens(m) / m.requests) : null),
              render: (m) => (m.requests ? formatNumber(Math.round(modelTokens(m) / m.requests)) : "—"),
            },
            {
              key: "tokens",
              label: "Share",
              numeric: true,
              value: modelTokens,
              render: (m) => (
                <div className="flex items-center justify-end gap-2">
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-paper-sunken">
                    <div className="h-full rounded-full bg-accent/60" style={{ width: `${share(m) * 100}%` }} />
                  </div>
                  <span className="w-10">{(share(m) * 100).toFixed(1)}%</span>
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
