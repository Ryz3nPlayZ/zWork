// A file the agent made, shown inline in a reply. Click opens it in the
// user's own app (Excel, Word, Preview…); the folder button shows it in
// Finder. Only paths the backend confirms exist become chips.
import { useEffect, useState } from "react";
import { File, FileImage, FileSpreadsheet, FileText, FolderOpen, Presentation } from "lucide-react";
import { api } from "../lib/api";

// A path-looking inline code span: optional dirs, a name, a short extension.
const FILE_LIKE = /^(?:~\/|\/|\.{1,2}\/)?(?:[^\s`*?<>|"]+\/)*[^\s`*?<>|"/]+\.[A-Za-z][A-Za-z0-9]{0,4}$/;

export function looksLikeFile(s: string) {
  return s.length < 260 && FILE_LIKE.test(s);
}

// path -> exists, shared across messages so a chat re-render doesn't re-ask.
const known = new Map<string, boolean>();
const listeners = new Set<() => void>();

/** Asks the backend once which of these paths exist. */
export function useFileCheck(paths: string[]) {
  const [, bump] = useState(0);
  const key = paths.join("\n");
  useEffect(() => {
    const onChange = () => bump((n) => n + 1);
    listeners.add(onChange);
    const unknown = paths.filter((p) => !known.has(p));
    if (unknown.length) {
      // Mark as pending so parallel renders don't ask twice.
      unknown.forEach((p) => known.set(p, false));
      api
        .statFiles(unknown)
        .then(({ existing }) => {
          existing.forEach((p) => known.set(p, true));
          listeners.forEach((l) => l());
        })
        .catch(() => unknown.forEach((p) => known.delete(p)));
    }
    return () => {
      listeners.delete(onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (p: string) => known.get(p) === true;
}

function iconFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["xlsx", "xls", "csv", "tsv", "numbers", "ods"].includes(ext)) return FileSpreadsheet;
  if (["pptx", "ppt", "key", "odp"].includes(ext)) return Presentation;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].includes(ext)) return FileImage;
  if (["docx", "doc", "pdf", "md", "txt", "rtf", "pages", "odt", "html"].includes(ext)) return FileText;
  return File;
}

export function FileChip({ path }: { path: string }) {
  const [error, setError] = useState<string | null>(null);
  const name = path.split(/[\\/]/).pop() || path;
  const Icon = iconFor(name);

  const open = async (reveal: boolean) => {
    setError(null);
    try {
      await api.openFile(path, reveal);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <span className="group/file relative inline-flex max-w-full items-center align-middle">
      <button
        type="button"
        onClick={() => open(false)}
        title={`Open ${path}`}
        className="press inline-flex min-w-0 items-center gap-1.5 rounded-l-md border border-line bg-paper-raised py-0.5 pl-1.5 pr-2 text-[13px] font-medium text-ink hover:bg-paper-sunken"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
        <span className="truncate">{name}</span>
      </button>
      <button
        type="button"
        onClick={() => open(true)}
        title="Show in folder"
        aria-label={`Show ${name} in folder`}
        className="press inline-flex items-center self-stretch rounded-r-md border border-l-0 border-line bg-paper-raised px-1.5 text-ink-faint hover:bg-paper-sunken hover:text-ink"
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </button>
      {error && (
        <span className="absolute left-0 top-[calc(100%+4px)] z-30 w-max max-w-[260px] whitespace-normal rounded-md border border-line bg-paper px-2 py-1 text-[11.5px] text-ink-muted shadow-pop">
          {error}
        </span>
      )}
    </span>
  );
}
