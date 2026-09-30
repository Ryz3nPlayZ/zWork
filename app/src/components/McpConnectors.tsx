import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Download, Loader2, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { api, type McpDiscoverySource, type McpServer } from "../lib/api";
import { cn } from "../lib/cn";

/**
 * MCP connectors: any Model Context Protocol server — a local command
 * (`npx …`, `uvx …`), a remote URL, or a JSON snippet pasted from a README —
 * plus one-click import of servers already set up in Claude, Cursor, VS Code,
 * Windsurf, opencode, Gemini CLI or Codex.
 */
export function McpConnectors() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [sources, setSources] = useState<McpDiscoverySource[]>([]);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState<McpDiscoverySource | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setServers((await api.mcpServers()).servers);
    } catch {
      setServers([]);
    }
  }, []);

  const refreshSources = useCallback(async () => {
    try {
      setSources((await api.mcpDiscover()).sources);
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshSources();
  }, [refresh, refreshSources]);

  // Poll while anything is still starting up.
  const pending = servers?.some((s) => s.state === "connecting" || (s.enabled && s.state === "idle"));
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(t);
  }, [pending, refresh]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    try {
      await fn();
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  const importable = sources.filter((s) => s.servers.some((x) => !x.already_added));

  return (
    <section className="mt-14">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold text-ink">More connectors</h2>
          <p className="mt-1 max-w-[520px] text-[13px] leading-relaxed text-ink-soft">
            Many apps offer an &ldquo;MCP&rdquo; connector for AI assistants. If an app&rsquo;s help page
            gives you one, paste its setup text here and zWork can use that app too.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="press ring-focus rounded-xl border border-line bg-paper-raised p-2 text-ink-soft transition-colors hover:text-ink"
            aria-label="Refresh MCP connectors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="press ring-focus inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-[13px] font-medium text-paper transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Add connector
          </button>
        </div>
      </div>

      {importable.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-line bg-paper-raised/60 px-4 py-3 text-[12.5px] text-ink-soft">
          <Download className="h-4 w-4 text-ink-muted" />
          <span>Bring over connectors from</span>
          {importable.map((src) => (
            <button
              key={src.id}
              type="button"
              onClick={() => setImporting(src)}
              className="press ring-focus rounded-full border border-line bg-paper px-2.5 py-0.5 font-medium text-ink transition-colors hover:border-line-strong"
            >
              {src.label} · {src.servers.filter((x) => !x.already_added).length}
            </button>
          ))}
        </div>
      )}

      {servers === null ? (
        <div className="flex h-20 items-center justify-center text-ink-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : servers.length === 0 ? (
        <div className="rounded-2xl border border-line bg-paper-raised px-5 py-8 text-center text-[13px] text-ink-soft">
          Nothing added yet.
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-paper-raised">
          {servers.map((s) => (
            <ServerRow
              key={s.name}
              server={s}
              busy={busy === s.name}
              open={expanded === s.name}
              onToggleOpen={() => setExpanded(expanded === s.name ? null : s.name)}
              onToggleEnabled={() => void act(s.name, () => api.mcpSetEnabled(s.name, !s.enabled))}
              onRetry={() => void act(s.name, () => api.mcpConnect(s.name))}
              onRemove={() => void act(s.name, () => api.mcpRemove(s.name)).then(refreshSources)}
            />
          ))}
        </ul>
      )}

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            void refresh();
            void refreshSources();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          source={importing}
          onClose={() => setImporting(null)}
          onImported={() => {
            void refresh();
            void refreshSources();
          }}
        />
      )}
    </section>
  );
}

const STATE_LABEL: Record<McpServer["state"], string> = {
  connected: "Connected",
  connecting: "Starting…",
  error: "Can't connect",
  idle: "Waiting",
  disabled: "Off",
};

function ServerRow({
  server: s,
  busy,
  open,
  onToggleOpen,
  onToggleEnabled,
  onRetry,
  onRemove,
}: {
  server: McpServer;
  busy: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggleEnabled: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const starting = s.state === "connecting" || busy;
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleOpen}
          className="press ring-focus flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
          aria-expanded={open}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-paper-sunken text-ink-muted">
            <Server className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{s.name}</span>
              <StatusPill state={s.state} starting={starting} />
            </div>
            <div className="truncate font-mono text-[11.5px] text-ink-muted">{s.target}</div>
          </div>
          {s.state === "connected" && (
            <span className="shrink-0 text-[12px] text-ink-muted">
              {s.tools.length} tool{s.tools.length === 1 ? "" : "s"}
            </span>
          )}
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-ink-muted transition-transform", open && "rotate-180")} />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          aria-label={s.enabled ? `Turn off ${s.name}` : `Turn on ${s.name}`}
          disabled={busy}
          onClick={onToggleEnabled}
          className={cn(
            "press ring-focus relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:opacity-50",
            s.enabled ? "border-transparent bg-accent" : "border-line bg-paper-sunken",
          )}
        >
          <span
            className={cn(
              "pointer-events-none h-[1.125rem] w-[1.125rem] rounded-full bg-paper-raised shadow-sm transition-transform",
              s.enabled ? "translate-x-5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {s.state === "error" && s.error && (
        <div className="mt-2 flex items-start gap-3 rounded-xl border border-error/20 bg-error/5 px-3 py-2">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-error">
            {s.error}
          </pre>
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="press ring-focus shrink-0 rounded-lg border border-line bg-paper px-2.5 py-1 text-[12px] font-medium text-ink disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Retry"}
          </button>
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3 pl-12">
          {s.server_name && (
            <div className="text-[12px] text-ink-muted">
              {s.server_name}
              {s.server_version ? ` ${s.server_version}` : ""} · {s.transport === "stdio" ? "runs on this computer" : "remote"}
            </div>
          )}
          {s.tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {s.tools.map((t) => (
                <span
                  key={t.name}
                  title={t.description}
                  className="rounded-md border border-line bg-paper px-2 py-0.5 font-mono text-[11px] text-ink-soft"
                >
                  {t.name}
                  {!t.read_only && <span className="ml-1 text-ink-muted" title="Asks before running">•</span>}
                </span>
              ))}
            </div>
          )}
          {s.tools.some((t) => !t.read_only) && (
            <p className="text-[11.5px] text-ink-muted">• zWork asks before running tools that can make changes.</p>
          )}
          <div className="flex gap-2">
            {s.enabled && s.state !== "error" && (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                className="press ring-focus rounded-lg border border-line bg-paper px-2.5 py-1 text-[12px] font-medium text-ink-soft hover:text-ink disabled:opacity-50"
              >
                Reconnect
              </button>
            )}
            {confirmRemove ? (
              <>
                <button
                  type="button"
                  onClick={onRemove}
                  className="press ring-focus rounded-lg border border-error/30 bg-error/10 px-2.5 py-1 text-[12px] font-medium text-error"
                >
                  Remove {s.name}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  className="press ring-focus rounded-lg px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                className="press ring-focus inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] text-ink-muted hover:text-error"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function StatusPill({ state, starting }: { state: McpServer["state"]; starting: boolean }) {
  if (starting) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-ink-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        Starting…
      </span>
    );
  }
  const tone =
    state === "connected"
      ? "bg-success/10 text-success"
      : state === "error"
        ? "bg-error/10 text-error"
        : "bg-paper-sunken text-ink-muted";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", tone)}>
      {state === "connected" && <span className="h-1.5 w-1.5 rounded-full bg-success" />}
      {STATE_LABEL[state]}
    </span>
  );
}

// ── Add ─────────────────────────────────────────────────────────────────────

type AddMode = "command" | "url" | "paste";

/** Split a command line on whitespace, honouring single/double quotes. */
function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

/** `KEY=value` / `Header: value` lines → object. */
function parsePairs(text: string, sep: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

/** A readable default name from a package or host. */
function suggestName(mode: AddMode, commandLine: string, url: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/^(mcp-server-|server-)|(-mcp-server|-mcp|-server)$/g, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  if (mode === "url") {
    try {
      const host = new URL(url).hostname.replace(/^(www|mcp|api)\./, "");
      return clean(host.split(".")[0] ?? "");
    } catch {
      return "";
    }
  }
  // `npx -y @scope/pkg ~/dir` → the first positional that isn't a path.
  const [cmd, ...rest] = splitCommandLine(commandLine);
  const launchers = new Set(["npx", "uvx", "bunx", "pnpx", "node", "python", "python3", "uv", "run", "docker", "deno"]);
  const pkg =
    rest.find((p) => !p.startsWith("-") && !launchers.has(p) && !/^[~./]/.test(p)) ??
    (cmd ? cmd.split("/").pop() : "");
  return clean((pkg ?? "").replace(/(.)@[^/@]*$/, "$1")); // drop `@version`
}

function AddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [mode, setMode] = useState<AddMode>("paste");
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [paste, setPaste] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    let body: Parameters<typeof api.mcpAdd>[0];
    if (mode === "paste") {
      if (!paste.trim()) return setError("Paste the JSON from the server's setup instructions.");
      body = { paste };
    } else {
      const finalName = (name.trim() || suggestName(mode, commandLine, url)).replace(/[^A-Za-z0-9_-]+/g, "-");
      if (!finalName) return setError("Give this connector a name.");
      if (mode === "command") {
        const [command, ...args] = splitCommandLine(commandLine);
        if (!command) return setError("Enter the command that starts the server.");
        body = { name: finalName, config: { command, args, env: parsePairs(env, "=") } };
      } else {
        if (!/^https?:\/\//i.test(url.trim())) return setError("Enter the server's full URL (https://…).");
        body = { name: finalName, config: { url: url.trim(), headers: parsePairs(headers, ":") } };
      }
    }
    setSaving(true);
    try {
      const res = await api.mcpAdd(body);
      if (res.error) return setError(res.error);
      onAdded();
      const failed = res.results?.filter((r) => !r.ok) ?? [];
      if (failed.length) {
        setError(`Saved, but couldn't connect to ${failed.map((f) => `${f.name}: ${f.error}`).join("\n")}`);
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const input =
    "ring-focus w-full rounded-xl border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted";
  return (
    <Modal title="Add a connector" onClose={onClose}>
      <div className="mb-4 inline-flex rounded-xl border border-line bg-paper p-0.5 text-[12.5px]">
        {(
          [
            ["paste", "Paste config"],
            ["command", "Command"],
            ["url", "URL"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={cn(
              "press rounded-[10px] px-3 py-1.5 font-medium transition-colors",
              mode === id ? "bg-paper-raised text-ink shadow-sm" : "text-ink-muted hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "paste" && (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            Most servers' instructions include a JSON block for Claude, Cursor or VS Code — paste it as is.
          </p>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={9}
            spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]\n    }\n  }\n}'}
            className={cn(input, "font-mono text-[12px] leading-relaxed")}
          />
        </div>
      )}

      {mode !== "paste" && (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-soft">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={suggestName(mode, commandLine, url) || "my-connector"}
              className={input}
            />
          </label>
          {mode === "command" ? (
            <>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-ink-soft">Command</span>
                <input
                  value={commandLine}
                  onChange={(e) => setCommandLine(e.target.value)}
                  spellCheck={false}
                  placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents"
                  className={cn(input, "font-mono text-[12px]")}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-ink-soft">
                  Environment variables <span className="font-normal text-ink-muted">— one KEY=value per line</span>
                </span>
                <textarea
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder="API_KEY=…"
                  className={cn(input, "font-mono text-[12px]")}
                />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-ink-soft">Server URL</span>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  spellCheck={false}
                  placeholder="https://example.com/mcp"
                  className={cn(input, "font-mono text-[12px]")}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-ink-soft">
                  Headers <span className="font-normal text-ink-muted">— optional, one Name: value per line</span>
                </span>
                <textarea
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  placeholder="Authorization: Bearer …"
                  className={cn(input, "font-mono text-[12px]")}
                />
              </label>
            </>
          )}
        </div>
      )}

      {error && (
        <pre className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-error/20 bg-error/5 px-3 py-2 font-sans text-[12px] leading-relaxed text-error">
          {error}
        </pre>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="press ring-focus rounded-xl px-3.5 py-2 text-[13px] text-ink-soft hover:text-ink"
        >
          {error?.startsWith("Saved") ? "Done" : "Cancel"}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving}
          className="press ring-focus inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-paper disabled:opacity-60"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {saving ? "Connecting…" : "Add"}
        </button>
      </div>
    </Modal>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────

function ImportDialog({
  source,
  onClose,
  onImported,
}: {
  source: McpDiscoverySource;
  onClose: () => void;
  onImported: () => void;
}) {
  const candidates = source.servers.filter((s) => !s.already_added);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(candidates.map((c) => c.name)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.mcpImport(source.id, [...picked]);
      if (!res.success) return setError(res.error ?? "Import failed.");
      onImported();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Import from ${source.label}`} onClose={onClose}>
      <p className="mb-3 text-[12.5px] text-ink-soft">
        These servers are set up in {source.label}. zWork copies their settings; {source.label} is not changed.
      </p>
      <ul className="max-h-[320px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {candidates.map((c) => (
          <li key={c.name}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
              <input
                type="checkbox"
                checked={picked.has(c.name)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(c.name);
                  else next.delete(c.name);
                  setPicked(next);
                }}
                className="h-4 w-4 accent-[rgb(var(--accent))]"
              />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">{c.name}</div>
                <div className="truncate font-mono text-[11px] text-ink-muted">{c.target}</div>
              </div>
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="mt-3 text-[12px] text-error">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="press ring-focus rounded-xl px-3.5 py-2 text-[13px] text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || picked.size === 0}
          className="press ring-focus inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-paper disabled:opacity-60"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Import {picked.size}
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-paper/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-[520px] rounded-2xl border border-line bg-paper-raised p-6 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-[17px] font-semibold text-ink">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="press rounded-lg p-1.5 text-ink-muted hover:bg-line/40 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
