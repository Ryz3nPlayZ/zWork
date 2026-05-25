import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Plus, Trash2, Download, Search, ArrowUpDown, ChevronUp, ChevronDown } from "lucide-react";
import { useApp } from "../../lib/store";
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

function toTSV(rows: string[][]): string {
  return rows.map((r) => r.join("\t")).join("\n");
}

export function ArtifactSheetViewer({ artifact }: { artifact: Artifact }) {
  const updateArtifact = useApp((s) => s.updateArtifact);
  const initialRows = artifact.rows ?? parseCSV(artifact.content);
  const [rows, setRows] = useState<string[][]>(initialRows);
  const [selectedCell, setSelectedCell] = useState<[number, number] | null>(null);
  const [editingCell, setEditingCell] = useState<[number, number] | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sorting & Filtering State
  const [filterQuery, setFilterQuery] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editingCell]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      updateArtifact(artifact.id, { content: toTSV(rows), rows }).catch(() => {});
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateCell = useCallback(
    (r: number, c: number, value: string) => {
      setRows((prev) => {
        const next = prev.map((row) => [...row]);
        if (next[r]) {
          next[r][c] = value;
        }
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

  const handleHeaderClick = useCallback((c: number) => {
    setSortCol((prev) => {
      if (prev === c) {
        setSortAsc((asc) => !asc);
        return c;
      }
      setSortAsc(true);
      return c;
    });
  }, []);

  // Compute filtered and sorted rows with original index mapping
  const filteredAndSortedData = useMemo(() => {
    let mapped = rows.map((row, index) => ({ row, originalIndex: index }));

    // Apply text filter case-insensitive
    if (filterQuery.trim()) {
      const q = filterQuery.toLowerCase();
      mapped = mapped.filter(({ row }) =>
        row.some((cell) => cell.toLowerCase().includes(q))
      );
    }

    // Apply sorting
    if (sortCol !== null) {
      mapped.sort((a, b) => {
        const valA = a.row[sortCol] ?? "";
        const valB = b.row[sortCol] ?? "";
        
        const numA = parseFloat(valA);
        const numB = parseFloat(valB);

        if (!isNaN(numA) && !isNaN(numB)) {
          return sortAsc ? numA - numB : numB - numA;
        }

        return sortAsc
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      });
    }

    return mapped;
  }, [rows, filterQuery, sortCol, sortAsc]);

  const colCount = rows[0]?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1.5 bg-paper-sunken/40">
        <button
          type="button"
          onClick={addRow}
          className="press flex items-center gap-1 rounded px-2.5 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink font-medium transition"
          title="Add row"
        >
          <Plus className="h-3 w-3" /> Row
        </button>
        <button
          type="button"
          onClick={addCol}
          className="press flex items-center gap-1 rounded px-2.5 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink font-medium transition"
          title="Add column"
        >
          <Plus className="h-3 w-3" /> Col
        </button>
        {selectedCell && (
          <button
            type="button"
            onClick={() => deleteRow(selectedCell[0])}
            className="press flex items-center gap-1 rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-500/10 font-medium transition"
            title="Delete row"
          >
            <Trash2 className="h-3 w-3" /> Delete Row
          </button>
        )}

        {/* Filter Input */}
        <div className="relative flex items-center ml-2">
          <Search className="absolute left-2.5 h-3 w-3 text-ink-faint" />
          <input
            type="text"
            placeholder="Filter data..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="rounded border border-line bg-paper pl-7 pr-2.5 py-1 text-[11px] outline-none focus:border-accent focus:ring-1 focus:ring-accent transition w-36 sm:w-48"
          />
        </div>

        <div className="flex-1" />
        
        <button
          type="button"
          onClick={exportCSV}
          className="press flex items-center gap-1 rounded px-2.5 py-1 text-[11px] text-ink-muted hover:bg-paper-sunken hover:text-ink font-medium transition"
        >
          <Download className="h-3 w-3" /> Export CSV
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {Array.from({ length: colCount }).map((_, c) => {
                const isSorted = sortCol === c;
                return (
                  <th
                    key={c}
                    onClick={() => handleHeaderClick(c)}
                    className="sticky top-0 z-10 border border-line bg-paper-sunken px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint hover:text-ink hover:bg-paper cursor-pointer select-none transition"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>{String.fromCharCode(65 + c)}</span>
                      {isSorted ? (
                        sortAsc ? (
                          <ChevronUp className="h-3 w-3 text-accent" />
                        ) : (
                          <ChevronDown className="h-3 w-3 text-accent" />
                        )
                      ) : (
                        <ArrowUpDown className="h-2.5 w-2.5 text-ink-faint group-hover:text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredAndSortedData.map(({ row, originalIndex: r }) => (
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
                        if (editingCell && (editingCell[0] !== r || editingCell[1] !== c)) {
                          commitEdit();
                        }
                      }}
                      onDoubleClick={() => startEdit(r, c)}
                      className={`border border-line px-3 py-1.5 transition ${
                        isSelected
                          ? "ring-1 ring-inset ring-accent bg-accent/5"
                          : "hover:bg-paper-sunken/50"
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
      <div className="shrink-0 border-t border-line px-3 py-1 text-[10.5px] text-ink-faint bg-paper-sunken/20 flex items-center justify-between">
        <div>
          {rows.length} rows &times; {colCount} cols
          {selectedCell && (
            <span className="ml-2 font-medium">
              &middot; Cell {String.fromCharCode(65 + selectedCell[1])}{selectedCell[0] + 1}
            </span>
          )}
        </div>
        {filterQuery && (
          <div className="text-[10px] text-accent font-medium">
            Filtered: showing {filteredAndSortedData.length} of {rows.length} rows
          </div>
        )}
      </div>
    </div>
  );
}
