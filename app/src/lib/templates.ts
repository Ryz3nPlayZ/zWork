export interface PromptTemplate {
  id: string;
  trigger: string;
  title: string;
  body: string;
}

const STORAGE_KEY = "zwork.promptTemplates";

export const DEFAULT_TEMPLATES: PromptTemplate[] = [
  {
    id: "tpl-summarize",
    trigger: "summarize",
    title: "Summarize",
    body: "Summarize the following clearly and concisely. Lead with a one-sentence takeaway, then 3-5 bullet points covering the most important details.\n\n",
  },
  {
    id: "tpl-explain-error",
    trigger: "explain-error",
    title: "Explain error",
    body: "Explain this error in plain language. Include:\n- What it likely means\n- The most common root causes\n- A short checklist to diagnose it\n\nError:\n",
  },
  {
    id: "tpl-code-review",
    trigger: "code-review",
    title: "Code review",
    body: "Review the following code. Flag correctness issues, edge cases, performance concerns, and readability problems. Suggest concrete diffs where useful. Skip nitpicks unless they materially help.\n\n",
  },
  {
    id: "tpl-refactor",
    trigger: "refactor",
    title: "Refactor",
    body: "Refactor this code for clarity and maintainability. Preserve behavior. Explain each non-trivial change in one line.\n\n",
  },
  {
    id: "tpl-plan-task",
    trigger: "plan-task",
    title: "Plan a task",
    body: "Help me plan this task. Produce:\n1. A short problem statement\n2. A numbered step-by-step plan\n3. Risks or open questions\n\nTask:\n",
  },
  {
    id: "tpl-daily-standup",
    trigger: "daily-standup",
    title: "Daily standup",
    body: "Draft a concise daily standup update with three sections:\n- Yesterday\n- Today\n- Blockers\n\nUse short bullets. Keep it under 8 lines total.\n\nNotes:\n",
  },
];

function isTemplate(value: unknown): value is PromptTemplate {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.trigger === "string" &&
    typeof v.title === "string" &&
    typeof v.body === "string"
  );
}

export function loadTemplates(): PromptTemplate[] {
  if (typeof window === "undefined") return DEFAULT_TEMPLATES.slice();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TEMPLATES.slice();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_TEMPLATES.slice();
    const filtered = parsed.filter(isTemplate);
    return filtered.length > 0 ? filtered : DEFAULT_TEMPLATES.slice();
  } catch {
    return DEFAULT_TEMPLATES.slice();
  }
}

export function saveTemplates(templates: PromptTemplate[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    /* ignore quota / serialization errors */
  }
}

export function newTemplateId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTrigger(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
}

/**
 * Detects whether the caret in `value` is currently completing a slash
 * trigger. Returns the [start, end] range of the trigger token (including
 * the leading `/`) and the query (without the slash), or null when no
 * trigger is active.
 *
 * Triggers fire only when `/` is at the start of input or after whitespace,
 * and never inside a fenced code block.
 */
export function findSlashTrigger(
  value: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  if (caret < 0 || caret > value.length) return null;
  // End of the token: walk forward until whitespace.
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  // Start: walk back to the most recent whitespace boundary.
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  if (value[start] !== "/") return null;
  // Must be at the absolute start of input or preceded by whitespace.
  if (start > 0 && !/\s/.test(value[start - 1])) return null;
  // Disallow when the slash sits inside an unclosed fenced code block.
  if (isInsideCodeFence(value, start)) return null;
  const query = value.slice(start + 1, end);
  // Reject obvious non-trigger paths like `/usr/local`.
  if (query.includes("/")) return null;
  return { start, end, query };
}

function isInsideCodeFence(value: string, index: number): boolean {
  const before = value.slice(0, index);
  const fences = before.match(/```/g);
  return !!fences && fences.length % 2 === 1;
}

export function filterTemplates(
  templates: PromptTemplate[],
  query: string,
): PromptTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return templates;
  const starts: PromptTemplate[] = [];
  const contains: PromptTemplate[] = [];
  for (const t of templates) {
    const trig = t.trigger.toLowerCase();
    const title = t.title.toLowerCase();
    if (trig.startsWith(q) || title.startsWith(q)) starts.push(t);
    else if (trig.includes(q) || title.includes(q)) contains.push(t);
  }
  return [...starts, ...contains];
}
