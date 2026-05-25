import { useState } from "react";
import { useApp } from "../lib/store";
import { Inbox, CheckCircle2, Trash2, ArrowRight, Plus, Mail, Sparkles, Check, Loader2 } from "lucide-react";
import { streamChat } from "../lib/api";

export function InboxPage() {
  const tasks = useApp((s) => s.tasks);
  const addTask = useApp((s) => s.addTask);
  const updateTaskColumn = useApp((s) => s.updateTaskColumn);
  const deleteTask = useApp((s) => s.deleteTask);

  const [inputVal, setInputVal] = useState("");
  const [busy, setBusy] = useState(false);

  const inboxTasks = tasks.filter((t) => t.column === "inbox");

  const handleAdd = async () => {
    const val = inputVal.trim();
    if (!val || busy) return;
    setBusy(true);
    try {
      await addTask(val, "inbox");
      setInputVal("");
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      void handleAdd();
    }
  };

  const [emailText, setEmailText] = useState("");
  const [summaryText, setSummaryText] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [todos, setTodos] = useState<string[]>([]);
  const [importedCount, setImportedCount] = useState<number | null>(null);

  const handleSummarize = async () => {
    if (!emailText.trim() || summarizing) return;
    setSummarizing(true);
    setSummaryText("");
    setTodos([]);
    setImportedCount(null);

    let currentText = "";
    try {
      await streamChat(
        {
          message: "Please summarize the following email in 3 clear bullet points, and extract any actionable todos as checkbox items starting with '- [ ]'. Here is the email:\n\n" + emailText,
        },
        (event) => {
          if (event.type === "delta" && event.text) {
            currentText += event.text;
            setSummaryText(currentText);
          }
        }
      );

      const lines = currentText.split("\n");
      const foundTodos: string[] = [];
      for (const line of lines) {
        const cleaned = line.trim();
        if (cleaned.startsWith("- [ ]") || cleaned.startsWith("- [x]")) {
          const content = cleaned.replace(/^-\s*\[\s*[x ]\s*\]\s*/i, "").trim();
          if (content) foundTodos.push(content);
        } else if (cleaned.startsWith("* ") || cleaned.startsWith("- ")) {
          if (cleaned.toLowerCase().includes("todo") || cleaned.toLowerCase().includes("action")) {
            const content = cleaned.replace(/^-\s*/, "").replace(/^\*\s*/, "").trim();
            if (content) foundTodos.push(content);
          }
        }
      }
      setTodos(foundTodos);
    } catch (err) {
      console.error(err);
      setSummaryText("Failed to generate summary.");
    } finally {
      setSummarizing(false);
    }
  };

  const handleImportTodos = async () => {
    if (todos.length === 0) return;
    for (const todo of todos) {
      await addTask(todo, "inbox");
    }
    setImportedCount(todos.length);
    setTodos([]);
    setEmailText("");
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-paper">
      <div className="mx-auto w-full max-w-[800px] px-6 py-14">
        {/* Header */}
        <div className="mb-10 flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-line bg-paper-raised text-accent">
            <Inbox className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-serif text-[32px] tracking-tight leading-none text-ink">
              Inbox
            </h1>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-muted max-w-[500px]">
              Capture anything instantly. Organize it, set plans, or check it off when completed.
            </p>
          </div>
        </div>

        {/* Capture Input Card */}
        <div className="mb-8 rounded-2xl border border-line bg-paper-raised p-5 shadow-sm">
          <label htmlFor="inbox-input" className="block text-[12px] font-semibold uppercase tracking-wider text-ink-faint mb-2">
            Quick Capture
          </label>
          <div className="flex gap-2">
            <input
              id="inbox-input"
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Draft feedback for landing page design, call client at 2..."
              disabled={busy}
              className="flex-1 rounded-xl border border-line bg-paper px-4 py-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
            <button
              onClick={() => void handleAdd()}
              disabled={busy || !inputVal.trim()}
              className="press flex items-center justify-center gap-1.5 rounded-xl bg-ink px-4 text-[12.5px] font-medium text-paper hover:bg-ink/90 disabled:opacity-45"
            >
              <Plus className="h-4 w-4" />
              <span>Add</span>
            </button>
          </div>
        </div>

        {/* Email Summarizer Card */}
        <div className="mb-8 rounded-2xl border border-line bg-paper-raised p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Mail className="h-4.5 w-4.5 text-accent" />
            <h2 className="text-[14px] font-semibold text-ink">Smart Email Summarizer</h2>
          </div>
          <p className="text-[12.5px] text-ink-muted mb-4">
            Paste an email below to generate a concise summary and extract key todos instantly.
          </p>

          <textarea
            value={emailText}
            onChange={(e) => setEmailText(e.target.value)}
            placeholder="Paste your email here..."
            disabled={summarizing}
            className="w-full h-24 p-3 rounded-xl border border-line bg-paper text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none resize-none mb-3"
          />

          <div className="flex gap-2">
            <button
              onClick={handleSummarize}
              disabled={summarizing || !emailText.trim()}
              className="press flex items-center justify-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[12.5px] font-medium text-paper hover:bg-ink/90 disabled:opacity-45"
            >
              {summarizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              <span>{summarizing ? "Summarizing..." : "Summarize & Extract"}</span>
            </button>
            
            {todos.length > 0 && (
              <button
                onClick={handleImportTodos}
                className="press flex items-center justify-center gap-1.5 rounded-xl border border-line bg-paper px-4 py-2 text-[12.5px] font-medium text-ink-soft hover:bg-paper-sunken"
              >
                <Check className="h-4 w-4 text-emerald-500" />
                <span>Import {todos.length} Todos</span>
              </button>
            )}
          </div>

          {importedCount !== null && (
            <div className="mt-3 text-[12px] text-emerald-600 font-medium">
              ✓ Successfully imported {importedCount} todo items into your Inbox!
            </div>
          )}

          {summaryText && (
            <div className="mt-4 p-4 rounded-xl border border-line/50 bg-paper-soft text-[13px] text-ink leading-relaxed">
              <div className="font-semibold text-[11px] uppercase tracking-wider text-ink-faint mb-2">Summary & Extracted Tasks</div>
              <div className="whitespace-pre-wrap">{summaryText}</div>
            </div>
          )}
        </div>

        {/* Task List */}
        <div>
          <div className="mb-4 flex items-center justify-between border-b border-line pb-2">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-faint">
              Inbox Items ({inboxTasks.length})
            </span>
          </div>

          {inboxTasks.length === 0 ? (
            <div className="rounded-2xl border border-line border-dashed p-10 text-center">
              <Inbox className="mx-auto h-8 w-8 text-ink-faint" />
              <h3 className="mt-3 text-[13.5px] font-semibold text-ink">Your inbox is clean</h3>
              <p className="mt-1 text-[12.5px] text-ink-muted max-w-[280px] mx-auto">
                No items waiting here. Use the input above to capture ideas or tasks.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {inboxTasks.map((t) => (
                <div
                  key={t.id}
                  className="group/task flex items-center gap-3 rounded-xl border border-line bg-paper-raised p-3.5 hover:border-line-strong transition-colors duration-150"
                >
                  {/* Mark as Done */}
                  <button
                    onClick={() => void updateTaskColumn(t.id, "done")}
                    className="press text-ink-muted hover:text-emerald-600 transition-colors"
                    title="Mark completed"
                  >
                    <CheckCircle2 className="h-5 w-5" />
                  </button>

                  {/* Title */}
                  <span className="flex-1 text-[13px] text-ink leading-relaxed font-medium">
                    {t.title}
                  </span>

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => void updateTaskColumn(t.id, "todo")}
                      className="press flex items-center gap-1 rounded-lg border border-line bg-paper px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:bg-paper-sunken"
                      title="Move to Todo list"
                    >
                      <span>To Do</span>
                      <ArrowRight className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => void deleteTask(t.id)}
                      className="press p-1 rounded-lg text-ink-faint hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title="Delete item"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
