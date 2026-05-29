import React, { useState, useMemo, useRef, useEffect } from "react";
import { Download, LayoutGrid, BarChart2, Bold, AlignLeft, AlignCenter, AlignRight, DollarSign, Percent, Grid } from "lucide-react";

function colLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function letterToCol(letter: string): number {
  return letter.toUpperCase().charCodeAt(0) - 65;
}

interface CellStyle {
  bold?: boolean;
  align?: "left" | "center" | "right";
  bg?: string;
  border?: "all" | "bottom" | "none";
}

interface Sheet {
  name: string;
  gridData: string[][];
  cellStyles: Record<string, CellStyle>;
}

export function SpreadsheetEditor() {
  const colsCount = 8;
  const rowsCount = 15;
  
  // Column Widths State
  const [colWidths, setColWidths] = useState<number[]>(() => Array(10).fill(110));
  const isResizing = useRef<number | null>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Multi-sheet State
  const [sheets, setSheets] = useState<Sheet[]>(() => {
    const initialData = Array.from({ length: 15 }, () => Array(8).fill(""));
    initialData[0] = ["Item", "Q1 Sales", "Q2 Sales", "Change %", "", "", "", ""];
    initialData[1] = ["Laptop Pro", "12000", "15000", "0.25", "", "", "", ""];
    initialData[2] = ["Smart Monitor", "8000", "7500", "-0.06", "", "", "", ""];
    initialData[3] = ["Mech Keyboard", "3500", "4200", "0.20", "", "", "", ""];
    initialData[4] = ["Wireless Mouse", "1500", "1800", "0.20", "", "", "", ""];
    initialData[5] = ["USB-C Hub", "900", "1100", "0.22", "", "", "", ""];
    initialData[6] = ["Total", "=SUM(B2:B6)", "=SUM(C2:C6)", "=AVERAGE(D2:D6)", "", "", "", ""];

    const initialStyles: Record<string, CellStyle> = {
      "0,0": { bold: true, align: "center", bg: "#f1f5f9", border: "all" },
      "0,1": { bold: true, align: "center", bg: "#f1f5f9", border: "all" },
      "0,2": { bold: true, align: "center", bg: "#f1f5f9", border: "all" },
      "0,3": { bold: true, align: "center", bg: "#f1f5f9", border: "all" },
      "6,0": { bold: true, bg: "#f8fafc", border: "bottom" },
      "6,1": { bold: true, bg: "#f8fafc", border: "bottom" },
      "6,2": { bold: true, bg: "#f8fafc", border: "bottom" },
      "6,3": { bold: true, bg: "#f8fafc", border: "bottom" },
    };

    return [
      { name: "Product Sales", gridData: initialData, cellStyles: initialStyles },
      { name: "Cost Analysis", gridData: Array.from({ length: 15 }, () => Array(8).fill("")), cellStyles: {} },
    ];
  });
  
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const currentSheet = sheets[activeSheetIdx] || sheets[0];

  // Drag Select State (Multi-cell select)
  const [dragStart, setDragStart] = useState<[number, number] | null>(null);
  const [dragEnd, setDragEnd] = useState<[number, number] | null>(null);
  const [isMouseDown, setIsMouseDown] = useState(false);
  const [activeCell, setActiveCell] = useState<[number, number] | null>([1, 1]);
  const [editingCell, setEditingCell] = useState<[number, number] | null>(null);
  const [editVal, setEditVal] = useState("");
  
  // Format Toggles
  const [viewTab, setViewTab] = useState<"grid" | "charts">("grid");
  const [chartType, setChartType] = useState<"bar" | "line" | "pie">("bar");
  const [chartSourceCol, setChartSourceCol] = useState(1);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editingCell]);

  // Handle Drag Selection
  const handleCellMouseDown = (r: number, c: number) => {
    setIsMouseDown(true);
    setDragStart([r, c]);
    setDragEnd([r, c]);
    setActiveCell([r, c]);
    if (editingCell && (editingCell[0] !== r || editingCell[1] !== c)) {
      commitEdit();
    }
  };

  const handleCellMouseEnter = (r: number, c: number) => {
    if (isMouseDown && dragStart) {
      setDragEnd([r, c]);
    }
  };

  const handleCellMouseUp = () => {
    setIsMouseDown(false);
  };

  // Check if a cell is currently in the selected range
  const isCellSelected = (r: number, c: number) => {
    if (!dragStart || !dragEnd) return false;
    const startR = Math.min(dragStart[0], dragEnd[0]);
    const endR = Math.max(dragStart[0], dragEnd[0]);
    const startC = Math.min(dragStart[1], dragEnd[1]);
    const endC = Math.max(dragStart[1], dragEnd[1]);
    return r >= startR && r <= endR && c >= startC && c <= endC;
  };

  // Formula Evaluator Function
  const resolveCellValue = (val: string, currentData: string[][], visiting: Set<string>): number => {
    if (!val) return 0;
    if (!val.startsWith("=")) {
      const num = parseFloat(val);
      return isNaN(num) ? 0 : num;
    }

    const formulaTypeRegex = /=(SUM|AVERAGE|MIN|MAX|COUNT|PRODUCT)\(([^)]+)\)/i;
    const match = val.match(formulaTypeRegex);

    if (match) {
      const type = match[1].toUpperCase();
      const range = match[2];
      let cellsToEvaluate: [number, number][] = [];

      if (range.includes(":")) {
        const parts = range.split(":");
        const startCol = letterToCol(parts[0].charAt(0));
        const startRow = parseInt(parts[0].slice(1)) - 1;
        const endCol = letterToCol(parts[1].charAt(0));
        const endRow = parseInt(parts[1].slice(1)) - 1;

        for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
          for (let c = Math.min(startCol, endCol); c <= Math.max(startCol, endCol); c++) {
            cellsToEvaluate.push([r, c]);
          }
        }
      } else {
        const col = letterToCol(range.charAt(0));
        const row = parseInt(range.slice(1)) - 1;
        cellsToEvaluate.push([row, col]);
      }

      const values = cellsToEvaluate.map(([r, c]) => {
        const cellKey = `${r},${c}`;
        if (visiting.has(cellKey)) return 0;
        visiting.add(cellKey);
        const resolved = evaluateCell(r, c, currentData, visiting);
        visiting.delete(cellKey);
        const num = parseFloat(resolved);
        return isNaN(num) ? 0 : num;
      });

      switch (type) {
        case "SUM": return values.reduce((sum, v) => sum + v, 0);
        case "AVERAGE": return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
        case "MIN": return values.length ? Math.min(...values) : 0;
        case "MAX": return values.length ? Math.max(...values) : 0;
        case "COUNT": return values.filter(v => v !== 0).length;
        case "PRODUCT": return values.length ? values.reduce((prod, v) => prod * v, 1) : 0;
        default: return 0;
      }
    }
    return 0;
  };

  const evaluateCell = (r: number, c: number, currentData: string[][], visiting: Set<string>): string => {
    const raw = currentData[r]?.[c] ?? "";
    if (!raw.startsWith("=")) return raw;
    try {
      const val = resolveCellValue(raw, currentData, visiting);
      return Number.isInteger(val) ? val.toString() : val.toFixed(2);
    } catch {
      return "#REF!";
    }
  };

  const evaluatedData = useMemo(() => {
    const data = Array.from({ length: rowsCount }, () => Array(colsCount).fill(""));
    for (let r = 0; r < rowsCount; r++) {
      for (let c = 0; c < colsCount; c++) {
        data[r][c] = evaluateCell(r, c, currentSheet.gridData, new Set());
      }
    }
    return data;
  }, [currentSheet.gridData, rowsCount, colsCount]);

  const startEdit = (r: number, c: number) => {
    setEditingCell([r, c]);
    setEditVal(currentSheet.gridData[r]?.[c] ?? "");
  };

  const commitEdit = () => {
    if (editingCell) {
      const [r, c] = editingCell;
      updateSheetData(r, c, editVal);
      setEditingCell(null);
    }
  };

  const updateActiveCellVal = (value: string) => {
    setEditVal(value);
    if (editingCell) return;
    if (activeCell) {
      const [r, c] = activeCell;
      updateSheetData(r, c, value);
    }
  };

  const updateSheetData = (r: number, c: number, val: string) => {
    setSheets(prev => {
      const next = [...prev];
      const target = next[activeSheetIdx];
      const nextGrid = target.gridData.map(row => [...row]);
      nextGrid[r][c] = val;
      next[activeSheetIdx] = { ...target, gridData: nextGrid };
      return next;
    });
  };

  const applyStyle = (styleKey: keyof CellStyle, value: any) => {
    if (!dragStart || !dragEnd) return;
    const startR = Math.min(dragStart[0], dragEnd[0]);
    const endR = Math.max(dragStart[0], dragEnd[0]);
    const startC = Math.min(dragStart[1], dragEnd[1]);
    const endC = Math.max(dragStart[1], dragEnd[1]);

    setSheets(prev => {
      const next = [...prev];
      const target = next[activeSheetIdx];
      const nextStyles = { ...target.cellStyles };

      for (let r = startR; r <= endR; r++) {
        for (let c = startC; c <= endC; c++) {
          const key = `${r},${c}`;
          nextStyles[key] = {
            ...nextStyles[key],
            [styleKey]: nextStyles[key]?.[styleKey] === value ? undefined : value
          };
        }
      }
      next[activeSheetIdx] = { ...target, cellStyles: nextStyles };
      return next;
    });
  };

  // Cell format helpers
  const formatCellAs = (type: "currency" | "percent" | "plain") => {
    if (!dragStart || !dragEnd) return;
    const startR = Math.min(dragStart[0], dragEnd[0]);
    const endR = Math.max(dragStart[0], dragEnd[0]);
    const startC = Math.min(dragStart[1], dragEnd[1]);
    const endC = Math.max(dragStart[1], dragEnd[1]);

    setSheets(prev => {
      const next = [...prev];
      const target = next[activeSheetIdx];
      const nextGrid = target.gridData.map(row => [...row]);

      for (let r = startR; r <= endR; r++) {
        for (let c = startC; c <= endC; c++) {
          const raw = nextGrid[r][c];
          if (!raw || raw.startsWith("=")) continue;
          const num = parseFloat(raw);
          if (isNaN(num)) continue;

          if (type === "currency") {
            nextGrid[r][c] = `$${num.toFixed(2)}`;
          } else if (type === "percent") {
            nextGrid[r][c] = `${(num * 100).toFixed(0)}%`;
          } else {
            nextGrid[r][c] = raw.replace(/[$%]/g, "");
          }
        }
      }
      next[activeSheetIdx] = { ...target, gridData: nextGrid };
      return next;
    });
  };

  // Column Resizing logic
  const handleResizeMouseDown = (e: React.MouseEvent, c: number) => {
    e.preventDefault();
    isResizing.current = c;
    startX.current = e.clientX;
    startWidth.current = colWidths[c];
    document.addEventListener("mousemove", handleResizeMouseMove);
    document.addEventListener("mouseup", handleResizeMouseUp);
  };

  const handleResizeMouseMove = (e: MouseEvent) => {
    if (isResizing.current !== null) {
      const diff = e.clientX - startX.current;
      const targetCol = isResizing.current;
      setColWidths(prev => {
        const next = [...prev];
        next[targetCol] = Math.max(50, startWidth.current + diff);
        return next;
      });
    }
  };

  const handleResizeMouseUp = () => {
    isResizing.current = null;
    document.removeEventListener("mousemove", handleResizeMouseMove);
    document.removeEventListener("mouseup", handleResizeMouseUp);
  };

  const addSheet = () => {
    const name = `Sheet ${sheets.length + 1}`;
    setSheets(prev => [
      ...prev,
      { name, gridData: Array.from({ length: 15 }, () => Array(8).fill("")), cellStyles: {} }
    ]);
    setActiveSheetIdx(sheets.length);
  };

  const deleteSheet = () => {
    if (sheets.length <= 1) return;
    setSheets(prev => prev.filter((_, idx) => idx !== activeSheetIdx));
    setActiveSheetIdx(0);
  };

  const exportCSV = () => {
    const csvContent = currentSheet.gridData.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentSheet.name.replace(/\s+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!activeCell) return;
    const [r, c] = activeCell;

    if (editingCell) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
        if (r < rowsCount - 1) {
          setActiveCell([r + 1, c]);
          setDragStart([r + 1, c]);
          setDragEnd([r + 1, c]);
        }
      } else if (e.key === "Escape") {
        setEditingCell(null);
      }
      return;
    }

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        if (r > 0) {
          setActiveCell([r - 1, c]);
          setDragStart([r - 1, c]);
          setDragEnd([r - 1, c]);
        }
        break;
      case "ArrowDown":
        e.preventDefault();
        if (r < rowsCount - 1) {
          setActiveCell([r + 1, c]);
          setDragStart([r + 1, c]);
          setDragEnd([r + 1, c]);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (c > 0) {
          setActiveCell([r, c - 1]);
          setDragStart([r, c - 1]);
          setDragEnd([r, c - 1]);
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (c < colsCount - 1) {
          setActiveCell([r, c + 1]);
          setDragStart([r, c + 1]);
          setDragEnd([r, c + 1]);
        }
        break;
      case "Enter":
        e.preventDefault();
        startEdit(r, c);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          startEdit(r, c);
          setEditVal(e.key);
        }
        break;
    }
  };

  // SVG Chart rendering data mapping
  const chartData = useMemo(() => {
    const labels: string[] = [];
    const values: number[] = [];
    for (let r = 1; r <= 5; r++) {
      const label = evaluatedData[r]?.[0] || `Row ${r}`;
      const valStr = (evaluatedData[r]?.[chartSourceCol] || "0").replace(/[^\d.-]/g, "");
      const val = parseFloat(valStr);
      labels.push(label);
      values.push(isNaN(val) ? 0 : val);
    }
    return { labels, values };
  }, [evaluatedData, chartSourceCol]);

  const renderSVGChart = () => {
    const { labels, values } = chartData;
    const maxVal = Math.max(...values, 100);
    const height = 260;
    const width = 500;
    const padding = 40;
    
    if (chartType === "bar") {
      const chartWidth = width - padding * 2;
      const chartHeight = height - padding * 2;
      const barWidth = chartWidth / labels.length - 12;
      
      return (
        <svg viewBox={`0 0 ${width} ${height}`} style={chartStyles.svg}>
          {Array.from({ length: 5 }).map((_, idx) => {
            const y = padding + (chartHeight / 4) * idx;
            const gridVal = Math.round(maxVal - (maxVal / 4) * idx);
            return (
              <g key={idx}>
                <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="var(--border)" strokeWidth={0.5} />
                <text x={padding - 8} y={y + 4} textAnchor="end" fontSize={9} fill="var(--text-tertiary)">{gridVal}</text>
              </g>
            );
          })}
          {values.map((val, idx) => {
            const valHeight = (val / maxVal) * chartHeight;
            const x = padding + idx * (barWidth + 12) + 6;
            const y = height - padding - valHeight;
            return (
              <g key={idx}>
                <rect x={x} y={y} width={barWidth} height={valHeight} fill="var(--accent)" rx={3} />
                <text x={x + barWidth / 2} y={y - 6} textAnchor="middle" fontSize={10} fontWeight="bold" fill="var(--text-primary)">{val}</text>
                <text x={x + barWidth / 2} y={height - padding + 16} textAnchor="middle" fontSize={9} fill="var(--text-secondary)">{labels[idx]}</text>
              </g>
            );
          })}
        </svg>
      );
    } else if (chartType === "line") {
      const chartWidth = width - padding * 2;
      const chartHeight = height - padding * 2;
      const points = values.map((val, idx) => {
        const x = padding + (chartWidth / (labels.length - 1)) * idx;
        const y = height - padding - (val / maxVal) * chartHeight;
        return `${x},${y}`;
      }).join(" ");

      return (
        <svg viewBox={`0 0 ${width} ${height}`} style={chartStyles.svg}>
          {Array.from({ length: 5 }).map((_, idx) => {
            const y = padding + (chartHeight / 4) * idx;
            const gridVal = Math.round(maxVal - (maxVal / 4) * idx);
            return (
              <g key={idx}>
                <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="var(--border)" strokeWidth={0.5} />
                <text x={padding - 8} y={y + 4} textAnchor="end" fontSize={9} fill="var(--text-tertiary)">{gridVal}</text>
              </g>
            );
          })}
          <polyline fill="none" stroke="var(--accent)" strokeWidth={3} points={points} />
          {values.map((val, idx) => {
            const x = padding + (chartWidth / (labels.length - 1)) * idx;
            const y = height - padding - (val / maxVal) * chartHeight;
            return (
              <g key={idx}>
                <circle cx={x} cy={y} r={5} fill="var(--bg-secondary)" stroke="var(--accent)" strokeWidth={2.5} />
                <text x={x} y={y - 10} textAnchor="middle" fontSize={10} fontWeight="bold" fill="var(--text-primary)">{val}</text>
                <text x={x} y={height - padding + 16} textAnchor="middle" fontSize={9} fill="var(--text-secondary)">{labels[idx]}</text>
              </g>
            );
          })}
        </svg>
      );
    } else {
      const total = values.reduce((a, b) => a + b, 0) || 1;
      let cumAngle = 0;
      const center = 150;
      const radius = 90;
      const colors = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

      return (
        <svg viewBox={`0 0 ${width} ${height}`} style={chartStyles.svg}>
          {values.map((val, idx) => {
            const sliceAngle = (val / total) * 360;
            const x1 = center + radius * Math.cos((cumAngle * Math.PI) / 180);
            const y1 = center + radius * Math.sin((cumAngle * Math.PI) / 180);
            cumAngle += sliceAngle;
            const x2 = center + radius * Math.cos((cumAngle * Math.PI) / 180);
            const y2 = center + radius * Math.sin((cumAngle * Math.PI) / 180);
            const largeArc = sliceAngle > 180 ? 1 : 0;
            const pathData = `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
            
            const legendX = 280;
            const legendY = 60 + idx * 30;

            return (
              <g key={idx}>
                <path d={pathData} fill={colors[idx % colors.length]} stroke="var(--bg-secondary)" strokeWidth={2} />
                <rect x={legendX} y={legendY} width={12} height={12} fill={colors[idx % colors.length]} rx={2} />
                <text x={legendX + 20} y={legendY + 10} fontSize={11} fill="var(--text-primary)">
                  {labels[idx]}: {val} ({((val / total) * 100).toFixed(0)}%)
                </text>
              </g>
            );
          })}
        </svg>
      );
    }
  };

  return (
    <div style={gridStyles.container}>
      {/* spreadsheet Top Toolbar */}
      <div style={gridStyles.toolbar}>
        {/* Borders */}
        <button style={gridStyles.toolbarBtn} onClick={() => applyStyle("border", "all")} title="Borders All Cells">
          <Grid size={14} /> Borders
        </button>
        <button style={gridStyles.toolbarBtn} onClick={() => applyStyle("border", "bottom")} title="Borders Bottom Line">
          Borders Bottom
        </button>
        <button style={gridStyles.toolbarBtn} onClick={() => applyStyle("border", "none")} title="Borders Clear">
          Clear Borders
        </button>

        <div style={gridStyles.divider} />

        {/* Text styling */}
        <button 
          style={gridStyles.toolbarBtnIcon}
          onClick={() => applyStyle("bold", true)}
          title="Toggle Bold"
        >
          <Bold size={14} />
        </button>

        <div style={gridStyles.divider} />

        {/* Text Alignments */}
        <button style={gridStyles.toolbarBtnIcon} onClick={() => applyStyle("align", "left")} title="Align Left">
          <AlignLeft size={14} />
        </button>
        <button style={gridStyles.toolbarBtnIcon} onClick={() => applyStyle("align", "center")} title="Align Center">
          <AlignCenter size={14} />
        </button>
        <button style={gridStyles.toolbarBtnIcon} onClick={() => applyStyle("align", "right")} title="Align Right">
          <AlignRight size={14} />
        </button>

        <div style={gridStyles.divider} />

        {/* Formatting actions */}
        <button style={gridStyles.toolbarBtn} onClick={() => formatCellAs("currency")} title="Format as Currency">
          <DollarSign size={14} /> Currency
        </button>
        <button style={gridStyles.toolbarBtn} onClick={() => formatCellAs("percent")} title="Format as Percentage">
          <Percent size={14} /> Percent
        </button>
        <button style={gridStyles.toolbarBtn} onClick={() => formatCellAs("plain")} title="Reset Formatting">
          Plain
        </button>

        <div style={{ flex: 1 }} />

        {/* View mode toggle */}
        <div style={gridStyles.tabToggle}>
          <button 
            style={{ ...gridStyles.tabBtn, ...(viewTab === "grid" ? gridStyles.tabBtnActive : {}) }}
            onClick={() => setViewTab("grid")}
          >
            <LayoutGrid size={13} />
            <span>Grid Sheet</span>
          </button>
          <button 
            style={{ ...gridStyles.tabBtn, ...(viewTab === "charts" ? gridStyles.tabBtnActive : {}) }}
            onClick={() => setViewTab("charts")}
          >
            <BarChart2 size={13} />
            <span>SVG Charting</span>
          </button>
        </div>

        <button style={gridStyles.toolbarBtn} onClick={exportCSV}>
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Formula Bar inputs */}
      <div style={gridStyles.formulaBar}>
        <div style={gridStyles.formulaCoord}>
          {activeCell ? `${colLetter(activeCell[1])}${activeCell[0] + 1}` : "--"}
        </div>
        <div style={gridStyles.formulaIndicator}>fx</div>
        <input 
          type="text" 
          value={editingCell ? editVal : activeCell ? (currentSheet.gridData[activeCell[0]]?.[activeCell[1]] ?? "") : ""}
          onChange={(e) => updateActiveCellVal(e.target.value)}
          placeholder="Enter values, text, or formulas like =SUM(B2:B6)"
          onKeyDown={handleKeyDown}
          style={gridStyles.formulaInput}
        />
      </div>

      {/* Grid Sheet View */}
      {viewTab === "grid" ? (
        <div style={gridStyles.gridViewport}>
          <table style={gridStyles.table} onKeyDown={handleKeyDown} tabIndex={0}>
            <thead>
              <tr>
                <th style={gridStyles.thIndex}></th>
                {Array.from({ length: colsCount }).map((_, c) => (
                  <th key={c} style={{ ...gridStyles.thCol, width: colWidths[c] }}>
                    <div style={gridStyles.thColContent}>
                      {colLetter(c)}
                      {/* Column resizing drag boundary handle */}
                      <div 
                        onMouseDown={(e) => handleResizeMouseDown(e, c)}
                        style={gridStyles.resizeHandle}
                      />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rowsCount }).map((_, r) => (
                <tr key={r}>
                  <td style={gridStyles.tdIndex}>{r + 1}</td>
                  {Array.from({ length: colsCount }).map((_, c) => {
                    const isSelected = isCellSelected(r, c);
                    const isActive = activeCell?.[0] === r && activeCell?.[1] === c;
                    const isEditing = editingCell?.[0] === r && editingCell?.[1] === c;
                    const style = currentSheet.cellStyles[`${r},${c}`] || {};
                    
                    return (
                      <td 
                        key={c} 
                        onMouseDown={() => handleCellMouseDown(r, c)}
                        onMouseEnter={() => handleCellMouseEnter(r, c)}
                        onMouseUp={handleCellMouseUp}
                        onDoubleClick={() => startEdit(r, c)}
                        style={{
                          ...gridStyles.tdCell,
                          width: colWidths[c],
                          backgroundColor: style.bg ? style.bg : (isSelected ? "rgba(99, 102, 241, 0.07)" : "var(--bg-secondary)"),
                          outline: isActive ? "2px solid var(--accent)" : "none",
                          fontWeight: style.bold ? "bold" : "normal",
                          textAlign: style.align ? style.align : "left",
                          border: style.border === "all" ? "1px solid var(--border-strong)" : (style.border === "bottom" ? "1px solid var(--border)" : "1px solid var(--border)"),
                          borderBottom: style.border === "bottom" || style.border === "all" ? "2px solid var(--text-primary)" : "1px solid var(--border)",
                        }}
                      >
                        {isEditing ? (
                          <input 
                            ref={inputRef}
                            type="text" 
                            value={editVal}
                            onChange={(e) => setEditVal(e.target.value)}
                            onBlur={commitEdit}
                            style={gridStyles.cellInput}
                          />
                        ) : (
                          evaluatedData[r]?.[c] || ""
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* Dynamic Vector SVG Charts View */
        <div style={chartStyles.container}>
          <div style={chartStyles.sidebar}>
            <h3 style={chartStyles.sidebarTitle}>SVG Chart Settings</h3>
            
            <div style={chartStyles.settingGroup}>
              <label style={chartStyles.label}>Chart type</label>
              <div style={chartStyles.btnGrid}>
                <button 
                  style={{ ...chartStyles.toggleBtn, ...(chartType === "bar" ? chartStyles.toggleBtnActive : {}) }}
                  onClick={() => setChartType("bar")}
                >
                  Bar
                </button>
                <button 
                  style={{ ...chartStyles.toggleBtn, ...(chartType === "line" ? chartStyles.toggleBtnActive : {}) }}
                  onClick={() => setChartType("line")}
                >
                  Line
                </button>
                <button 
                  style={{ ...chartStyles.toggleBtn, ...(chartType === "pie" ? chartStyles.toggleBtnActive : {}) }}
                  onClick={() => setChartType("pie")}
                >
                  Pie
                </button>
              </div>
            </div>

            <div style={chartStyles.settingGroup}>
              <label style={chartStyles.label}>Values Column</label>
              <select 
                style={chartStyles.select}
                value={chartSourceCol}
                onChange={(e) => setChartSourceCol(parseInt(e.target.value))}
              >
                <option value={1}>Column B (Q1 Sales)</option>
                <option value={2}>Column C (Q2 Sales)</option>
                <option value={3}>Column D (Change %)</option>
              </select>
            </div>
          </div>

          <div style={chartStyles.chartViewport}>
            <h4 style={chartStyles.chartTitle}>
              {chartType.toUpperCase()} CHART — {colLetter(chartSourceCol)} Column sales (Rows 2-6)
            </h4>
            <div style={chartStyles.svgContainer}>
              {renderSVGChart()}
            </div>
          </div>
        </div>
      )}

      {/* spreadsheet Multi-sheet tabs footer */}
      <div style={gridStyles.footerTabs}>
        {sheets.map((sheet, idx) => (
          <button 
            key={idx}
            style={{
              ...gridStyles.sheetTabBtn,
              backgroundColor: activeSheetIdx === idx ? "var(--bg-secondary)" : "var(--bg-tertiary)",
              borderTop: activeSheetIdx === idx ? "2.5px solid var(--accent)" : "1px solid transparent",
              fontWeight: activeSheetIdx === idx ? "bold" : "normal",
              color: activeSheetIdx === idx ? "var(--accent)" : "var(--text-secondary)"
            }}
            onClick={() => {
              setActiveSheetIdx(idx);
              setEditingCell(null);
              setDragStart(null);
              setDragEnd(null);
            }}
          >
            {sheet.name}
          </button>
        ))}
        <button style={gridStyles.addTabBtn} onClick={addSheet} title="Insert New Sheet">+</button>
        <button style={gridStyles.addTabBtn} onClick={deleteSheet} title="Delete Active Sheet" disabled={sheets.length <= 1}>x</button>
      </div>
    </div>
  );
}

const gridStyles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: "var(--bg-primary)",
    overflow: "hidden",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
    padding: "8px 16px",
    backgroundColor: "var(--bg-secondary)",
    borderBottom: "1px solid var(--border)",
    zIndex: 10,
    boxShadow: "var(--shadow-sm)",
  },
  toolbarBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 12px",
    fontSize: "12px",
    fontWeight: "500",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  toolbarBtnIcon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-secondary)",
    cursor: "pointer",
  },
  divider: {
    width: "1px",
    height: "18px",
    backgroundColor: "var(--border)",
    margin: "0 4px",
  },
  tabToggle: {
    display: "flex",
    backgroundColor: "var(--bg-tertiary)",
    borderRadius: "var(--radius-md)",
    padding: "2px",
    border: "1px solid var(--border)",
    marginRight: "8px",
  },
  tabBtn: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 12px",
    fontSize: "11.5px",
    fontWeight: "500",
    border: "none",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  tabBtnActive: {
    backgroundColor: "var(--bg-secondary)",
    color: "var(--accent)",
    boxShadow: "var(--shadow-sm)",
  },
  formulaBar: {
    display: "flex",
    alignItems: "center",
    height: "36px",
    backgroundColor: "var(--bg-secondary)",
    borderBottom: "1px solid var(--border)",
  },
  formulaCoord: {
    width: "50px",
    textAlign: "center",
    fontSize: "12px",
    fontWeight: "600",
    color: "var(--text-secondary)",
    borderRight: "1px solid var(--border)",
    lineHeight: "36px",
  },
  formulaIndicator: {
    padding: "0 10px",
    fontStyle: "italic",
    color: "var(--text-tertiary)",
    fontSize: "14px",
    fontWeight: "bold",
    userSelect: "none",
  },
  formulaInput: {
    flex: 1,
    height: "100%",
    border: "none",
    outline: "none",
    padding: "0 12px",
    fontSize: "12.5px",
    backgroundColor: "transparent",
    color: "var(--text-primary)",
  },
  gridViewport: {
    flex: 1,
    overflow: "auto",
    backgroundColor: "var(--bg-primary)",
  },
  table: {
    borderCollapse: "collapse",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    outline: "none",
  },
  thIndex: {
    width: "36px",
    backgroundColor: "var(--bg-tertiary)",
    border: "1px solid var(--border)",
    position: "sticky",
    top: 0,
    left: 0,
    zIndex: 3,
  },
  thCol: {
    backgroundColor: "var(--bg-tertiary)",
    border: "1px solid var(--border)",
    padding: 0,
    fontWeight: "600",
    color: "var(--text-secondary)",
    position: "sticky",
    top: 0,
    zIndex: 2,
    userSelect: "none",
  },
  thColContent: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    height: "28px",
    position: "relative",
  },
  resizeHandle: {
    position: "absolute",
    right: 0,
    top: 0,
    width: "4px",
    height: "100%",
    cursor: "col-resize",
    backgroundColor: "transparent",
    zIndex: 10,
  },
  tdIndex: {
    backgroundColor: "var(--bg-tertiary)",
    border: "1px solid var(--border)",
    textAlign: "center",
    fontWeight: "600",
    color: "var(--text-secondary)",
    position: "sticky",
    left: 0,
    zIndex: 1,
    width: "36px",
  },
  tdCell: {
    border: "1px solid var(--border)",
    padding: "6px 8px",
    height: "30px",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    cursor: "cell",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cellInput: {
    width: "100%",
    height: "100%",
    border: "none",
    outline: "none",
    background: "transparent",
    padding: 0,
    fontSize: "12px",
    fontFamily: "var(--font-sans)",
    color: "var(--text-primary)",
  },
  footerTabs: {
    display: "flex",
    alignItems: "center",
    height: "30px",
    backgroundColor: "var(--bg-tertiary)",
    borderTop: "1px solid var(--border)",
    paddingLeft: "36px",
  },
  sheetTabBtn: {
    padding: "0 16px",
    fontSize: "11px",
    fontWeight: "500",
    height: "100%",
    border: "none",
    borderRight: "1px solid var(--border)",
    cursor: "pointer",
  },
  addTabBtn: {
    padding: "0 10px",
    fontSize: "14px",
    height: "100%",
    border: "none",
    borderRight: "1px solid var(--border)",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
  }
};

const chartStyles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flex: 1,
    backgroundColor: "var(--bg-primary)",
    overflow: "hidden",
  },
  sidebar: {
    width: "250px",
    borderRight: "1px solid var(--border)",
    backgroundColor: "var(--bg-secondary)",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  sidebarTitle: {
    fontSize: "13px",
    fontWeight: "bold",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    color: "var(--text-secondary)",
  },
  settingGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  label: {
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--text-secondary)",
  },
  btnGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "4px",
  },
  toggleBtn: {
    padding: "6px",
    fontSize: "11px",
    fontWeight: "500",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-secondary)",
    cursor: "pointer",
  },
  toggleBtnActive: {
    borderColor: "var(--accent)",
    backgroundColor: "var(--accent-light)",
    color: "var(--accent)",
    fontWeight: "bold",
  },
  select: {
    padding: "6px 10px",
    fontSize: "12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    outline: "none",
    cursor: "pointer",
  },
  chartViewport: {
    flex: 1,
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    overflow: "auto",
  },
  chartTitle: {
    fontSize: "13px",
    fontWeight: "bold",
    color: "var(--text-secondary)",
    marginBottom: "20px",
    textAlign: "center",
    letterSpacing: "0.5px",
  },
  svgContainer: {
    width: "100%",
    maxWidth: "540px",
    backgroundColor: "var(--bg-secondary)",
    padding: "20px",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-md)",
    border: "1px solid var(--border)",
  },
  svg: {
    width: "100%",
    height: "auto",
    overflow: "visible",
  }
};
