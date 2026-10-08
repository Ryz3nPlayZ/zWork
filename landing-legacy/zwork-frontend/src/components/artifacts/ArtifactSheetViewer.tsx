import { useState, useCallback, useRef, useEffect } from "react";
import { Plus, Trash2, Download } from "lucide-react";
import type { Artifact } from "../../lib/store";

function parseCSV(raw: string): string[][] {
  return raw.split("\n").map((line) =>
    line.split("\t").map((cell) => cell.replace(/^"|"$/g, "").trim()),
  );
}

function toCSV(rows: string[][]): string {
  return rows
    .map((row) =>
      row.map((cell) => (cell.includes(",") || cell.includes('"') ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","),
    )
    .join("\n");
}

export function ArtifactSheetViewer({ artifact }: { artifact: Artifact }) {
  const initialRows = artifact.rows ?? parseCSV(artifact.content);
  const [rows, setRows] = useState<string[][]>(initialRows);
  const [selectedCell, setSelectedCell] = useState<[number, number] | null>(null);
  const [editingCell, setEditingCell] = useState<[number, number] | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editingCell]);

  const updateCell = useCallback(
    (r: number, c: number, value: string) => {
      setRows((prev) => {
        const next = prev.map((row) => [...row]);
        next[r][c] = value;
        return next;
      });
    },
    [],
  );

  const commitEdit = useCallback(() => {
    if (editingCell) {
      updateCell(editingCell[0], editingCell[1], editValue);
      setEditingCell(null);
    }
  }, [editingCell, editValue, updateCell]);

  const startEdit = useCallback(
    (r: number, c: number) => {
      setEditingCell([r, c]);
      setEditValue(rows[r]?.[c] ?? "");
    },
    [rows],
  );

  const addRow = useCallback(() => {
    const cols = rows[0]?.length ?? 1;
    setRows((prev) => [...prev, Array(cols).fill("")]);
  }, [rows]);

  const addCol = useCallback(() => {
    setRows((prev) => prev.map((row) => [...row, ""]));
  }, []);

  const deleteRow = useCallback(
    (r: number) => {
      if (rows.length <= 1) return;
      setRows((prev) => prev.filter((_, i) => i !== r));
      setSelectedCell(null);
    },
    [rows],
  );

  const exportCSV = useCallback(() => {
    const csv = toCSV(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.title.replace(/\s+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows, artifact.title]);

  const colCount = rows[0]?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        <button
          type="button"
          onClick={addRow}
          className="press flex items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Add row"
        >
          <Plus className="h-3 w-3" /> Row
        </button>
        <button
          type="button"
          onClick={addCol}
          className="press flex items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
          title="Add column"
        >
          <Plus className="h-3 w-3" /> Col
        </button>
        {selectedCell && (
          <button
            type="button"
            onClick={() => deleteRow(selectedCell[0])}
            className="press flex items-center gap-1 rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-500/8"
            title="Delete row"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={exportCSV}
          className="press flex items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
        >
          <Download className="h-3 w-3" /> Export CSV
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {Array.from({ length: colCount }).map((_, c) => (
                <th
                  key={c}
                  className="sticky top-0 z-10 border border-line bg-paper-sunken px-3 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint"
                >
                  {String.fromCharCode(65 + c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="group/row">
                {row.map((cell, c) => {
                  const isSelected =
                    selectedCell?.[0] === r && selectedCell?.[1] === c;
                  const isEditing =
                    editingCell?.[0] === r && editingCell?.[1] === c;

                  return (
                    <td
                      key={c}
                      onClick={() => {
                        setSelectedCell([r, c]);
                        if (editingCell && editingCell[0] !== r && editingCell[1] !== c) {
                          commitEdit();
                        }
                      }}
                      onDoubleClick={() => startEdit(r, c)}
                      className={`border border-line px-3 py-1.5 ${
                        isSelected
                          ? "ring-1 ring-inset ring-accent bg-accent/5"
                          : "hover:bg-paper-sunken"
                      }`}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditingCell(null);
                            if (e.key === "Tab") {
                              e.preventDefault();
                              commitEdit();
                              const nextC = e.shiftKey
                                ? Math.max(0, c - 1)
                                : Math.min(colCount - 1, c + 1);
                              startEdit(r, nextC);
                            }
                          }}
                          className="w-full bg-transparent text-[12px] text-ink outline-none"
                        />
                      ) : (
                        <span className="text-ink">{cell || " "}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Status */}
      <div className="shrink-0 border-t border-line px-3 py-1 text-[10.5px] text-ink-faint">
        {rows.length} rows &times; {colCount} cols
        {selectedCell && (
          <span className="ml-2">
            &middot; Cell {String.fromCharCode(65 + selectedCell[1])}{selectedCell[0] + 1}
          </span>
        )}
      </div>
    </div>
  );
}
