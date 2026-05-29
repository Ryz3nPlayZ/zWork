import React, { useRef, useState, useEffect } from "react";
import { 
  Bold, Italic, Underline, Strikethrough, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, FileText, Copy, Printer, Check, Highlighter, Scissors
} from "lucide-react";

export function DocumentEditor() {
  const editorRef = useRef<HTMLDivElement>(null);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [fontSize, setFontSize] = useState<number>(14);
  const [highlightColor, setHighlightColor] = useState("#fef08a"); // Light yellow
  const [lineSpacing, setLineSpacing] = useState("1.15");

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = "<div><p><br></p></div>";
      updateCounts();
    }
  }, []);

  // Track font size of active cursor selection
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      let node = selection.anchorNode;
      if (node && node.nodeType === Node.TEXT_NODE) {
        node = node.parentNode;
      }
      if (node && node instanceof HTMLElement) {
        const computedStyle = window.getComputedStyle(node);
        const fSize = parseFloat(computedStyle.fontSize);
        if (!isNaN(fSize)) {
          setFontSize(Math.round(fSize));
        }
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  const format = (command: string, value: string = "") => {
    document.execCommand(command, false, value);
    if (editorRef.current) {
      editorRef.current.focus();
    }
    updateCounts();
  };

  const updateCounts = () => {
    if (!editorRef.current) return;
    const text = editorRef.current.innerText || "";
    const cleanText = text.trim().replace(/\s+/g, " ");
    const words = cleanText ? cleanText.split(" ").length : 0;
    setWordCount(words);
    setCharCount(text.length);
  };

  const applyFontSize = (sizePx: number) => {
    setFontSize(sizePx);
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.toString().length === 0) {
      document.execCommand("fontSize", false, "3");
      return;
    }
    const range = selection.getRangeAt(0);
    const span = document.createElement("span");
    span.style.fontSize = `${sizePx}px`;
    try {
      range.surroundContents(span);
    } catch {
      const fragment = range.extractContents();
      span.appendChild(fragment);
      range.insertNode(span);
    }
    if (editorRef.current) editorRef.current.focus();
    updateCounts();
  };

  const handleFontSizeChange = (valStr: string) => {
    const parsed = parseInt(valStr);
    if (!isNaN(parsed) && parsed > 4 && parsed < 96) {
      applyFontSize(parsed);
    }
  };

  const applyLineSpacing = (spacing: string) => {
    setLineSpacing(spacing);
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    let node = selection.anchorNode;
    while (node && node !== editorRef.current) {
      if (node.nodeType === Node.ELEMENT_NODE && ["P", "DIV", "H1", "H2", "H3", "LI"].includes((node as Element).tagName)) {
        (node as HTMLElement).style.lineHeight = spacing;
        break;
      }
      node = node.parentNode;
    }
    if (editorRef.current) editorRef.current.focus();
  };

  const printToPDF = () => {
    window.print();
  };

  const copyHTML = () => {
    if (!editorRef.current) return;
    navigator.clipboard.writeText(editorRef.current.innerHTML).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={styles.container} className="no-print">
      {/* Microsoft Word styled "Ribbon" Header */}
      <div style={styles.ribbon}>
        {/* Ribbon Tab Header Mock */}
        <div style={styles.ribbonTabs}>
          <button style={styles.ribbonTabActive}>Home</button>
          <button style={styles.ribbonTab}>Insert</button>
          <button style={styles.ribbonTab}>Layout</button>
          <button style={styles.ribbonTab}>View</button>
        </div>

        {/* Ribbon Groups Content */}
        <div style={styles.ribbonContent}>
          {/* Group 1: Clipboard */}
          <div style={styles.ribbonGroup}>
            <div style={styles.ribbonRow}>
              <button style={styles.ribbonActionBtn} onClick={copyHTML}>
                {copied ? <Check size={14} style={{ color: "#10b981" }} /> : <Copy size={14} />}
                <span style={styles.btnLabel}>{copied ? "Copied" : "Copy HTML"}</span>
              </button>
              <button style={styles.ribbonActionBtn} onClick={() => format("cut")} title="Cut selection">
                <Scissors size={14} />
                <span style={styles.btnLabel}>Cut</span>
              </button>
            </div>
            <div style={styles.groupLabel}>Clipboard</div>
          </div>

          <div style={styles.verticalDivider} />

          {/* Group 2: Font Formatting */}
          <div style={styles.ribbonGroup}>
            <div style={styles.ribbonRow}>
              {/* Heading select */}
              <select 
                style={styles.select}
                onChange={(e) => format("formatBlock", e.target.value)}
                defaultValue="<p>"
                title="Style block"
              >
                <option value="<h1>">Heading 1</option>
                <option value="<h2>">Heading 2</option>
                <option value="<h3>">Heading 3</option>
                <option value="<p>">Normal (Calibri)</option>
              </select>

              {/* Custom font size box with + / - buttons */}
              <div style={styles.sizeControl}>
                <button style={styles.sizeBtn} onClick={() => applyFontSize(Math.max(6, fontSize - 1))}>-</button>
                <input 
                  type="text" 
                  value={fontSize} 
                  onChange={(e) => handleFontSizeChange(e.target.value)}
                  style={styles.sizeInput}
                />
                <button style={styles.sizeBtn} onClick={() => applyFontSize(Math.min(96, fontSize + 1))}>+</button>
              </div>
            </div>

            <div style={{ ...styles.ribbonRow, marginTop: "6px" }}>
              <button style={styles.btnIcon} onClick={() => format("bold")} title="Bold">
                <Bold size={14} />
              </button>
              <button style={styles.btnIcon} onClick={() => format("italic")} title="Italic">
                <Italic size={14} />
              </button>
              <button style={styles.btnIcon} onClick={() => format("underline")} title="Underline">
                <Underline size={14} />
              </button>
              <button style={styles.btnIcon} onClick={() => format("strikeThrough")} title="Strikethrough">
                <Strikethrough size={14} />
              </button>

              <div style={styles.innerDivider} />

              {/* Text Highlight backColor selection */}
              <div style={styles.colorPickerWrapper} title="Text Highlight Color">
                <Highlighter size={14} style={{ color: highlightColor, filter: "drop-shadow(0px 1px 1px rgba(0,0,0,0.15))" }} />
                <input 
                  type="color" 
                  value={highlightColor} 
                  onChange={(e) => {
                    setHighlightColor(e.target.value);
                    format("hiliteColor", e.target.value);
                  }}
                  style={styles.colorInput}
                />
              </div>
            </div>
            <div style={styles.groupLabel}>Font</div>
          </div>

          <div style={styles.verticalDivider} />

          {/* Group 3: Paragraph Formatting */}
          <div style={styles.ribbonGroup}>
            <div style={styles.ribbonRow}>
              {/* Alignments */}
              <button style={styles.btnIcon} onClick={() => format("justifyLeft")} title="Align Left">
                <AlignLeft size={14} />
              </button>
              <button style={styles.btnIcon} onClick={() => format("justifyCenter")} title="Align Center">
                <AlignCenter size={14} />
              </button>
              <button style={styles.btnIcon} onClick={() => format("justifyRight")} title="Align Right">
                <AlignRight size={14} />
              </button>
              <button style={styles.btnIcon} onClick={() => format("justifyFull")} title="Justify Align">
                <AlignJustify size={14} />
              </button>

              <div style={styles.innerDivider} />

              {/* Lists */}
              <button style={styles.btnIcon} onClick={() => format("insertUnorderedList")} title="Bulleted List">
                <List size={14} />
              </button>
              <button style={styles.btnIcon} onClick={() => format("insertOrderedList")} title="Numbered List">
                <ListOrdered size={14} />
              </button>
            </div>

            <div style={{ ...styles.ribbonRow, marginTop: "6px" }}>
              {/* Line height selector */}
              <select 
                style={{ ...styles.select, width: "135px" }}
                value={lineSpacing}
                onChange={(e) => applyLineSpacing(e.target.value)}
                title="Line height spacing"
              >
                <option value="1.0">Spacing: 1.0 (Single)</option>
                <option value="1.15">Spacing: 1.15</option>
                <option value="1.5">Spacing: 1.5</option>
                <option value="2.0">Spacing: 2.0 (Double)</option>
              </select>
            </div>
            <div style={styles.groupLabel}>Paragraph</div>
          </div>

          <div style={styles.verticalDivider} />

          {/* Group 4: Page PDF Export */}
          <div style={styles.ribbonGroup}>
            <div style={styles.ribbonRow}>
              <button style={{ ...styles.ribbonActionBtn, height: "38px" }} onClick={printToPDF} title="Export to PDF Document">
                <Printer size={15} style={{ color: "var(--accent)" }} />
                <span style={{ ...styles.btnLabel, fontWeight: "600", color: "var(--accent)" }}>Save to PDF</span>
              </button>
            </div>
            <div style={styles.groupLabel}>Document</div>
          </div>
        </div>
      </div>

      {/* Horizontal Page Ruler */}
      <div style={styles.horizontalRuler}>
        <div style={styles.rulerMarginStart} />
        <div style={styles.rulerCenterTicks}>
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} style={styles.rulerMarker}>
              <span style={styles.rulerNumber}>{i + 1}</span>
            </div>
          ))}
        </div>
        <div style={styles.rulerMarginEnd} />
      </div>

      {/* Margins Workspace Split */}
      <div style={styles.workspaceContainer}>
        {/* Vertical Ruler on Left side */}
        <div style={styles.verticalRuler}>
          <div style={styles.vRulerMarginStart} />
          <div style={styles.vRulerCenterTicks}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={styles.vRulerMarker}>
                <span style={styles.vRulerNumber}>{i + 1}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Paper viewport */}
        <div style={styles.paperViewport}>
          <div 
            ref={editorRef}
            style={styles.paper}
            className="print-paper"
            contentEditable={true}
            onInput={updateCounts}
            onKeyUp={updateCounts}
            spellCheck={false}
            data-placeholder="Start typing your document here..."
          />
        </div>
      </div>

      {/* Status Bar */}
      <div style={styles.statusBar}>
        <div style={styles.statusItem}>
          <FileText size={13} />
          <span>Page 1 of 1</span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={styles.statusItem}>
          <span><strong>Words:</strong> {wordCount}</span>
          <span style={styles.statusBarDot}>•</span>
          <span><strong>Characters:</strong> {charCount}</span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: "var(--bg-primary)",
    overflow: "hidden",
  },
  ribbon: {
    display: "flex",
    flexDirection: "column",
    backgroundColor: "var(--bg-secondary)",
    borderBottom: "1px solid var(--border)",
    boxShadow: "var(--shadow-sm)",
    zIndex: 100,
  },
  ribbonTabs: {
    display: "flex",
    paddingLeft: "24px",
    borderBottom: "1px solid var(--border)",
    height: "28px",
    backgroundColor: "var(--bg-tertiary)",
  },
  ribbonTab: {
    padding: "0 16px",
    fontSize: "11.5px",
    fontWeight: "500",
    color: "var(--text-secondary)",
    border: "none",
    background: "transparent",
    cursor: "pointer",
  },
  ribbonTabActive: {
    padding: "0 16px",
    fontSize: "11.5px",
    fontWeight: "600",
    color: "var(--accent)",
    border: "none",
    borderBottom: "2px solid var(--accent)",
    backgroundColor: "var(--bg-secondary)",
    cursor: "pointer",
  },
  ribbonContent: {
    display: "flex",
    alignItems: "center",
    padding: "6px 20px",
    gap: "12px",
    height: "76px",
    overflowX: "auto",
  },
  ribbonGroup: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    height: "100%",
    justifyContent: "space-between",
  },
  ribbonRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  groupLabel: {
    fontSize: "9px",
    fontWeight: "bold",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
    letterSpacing: "0.5px",
    marginTop: "2px",
  },
  verticalDivider: {
    width: "1px",
    height: "46px",
    backgroundColor: "var(--border)",
    margin: "0 4px",
  },
  innerDivider: {
    width: "1px",
    height: "14px",
    backgroundColor: "var(--border)",
    margin: "0 4px",
  },
  select: {
    padding: "4px 8px",
    fontSize: "11.5px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    outline: "none",
    cursor: "pointer",
    width: "120px",
  },
  sizeControl: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
  },
  sizeBtn: {
    width: "20px",
    height: "22px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
    fontWeight: "bold",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-tertiary)",
    color: "var(--text-secondary)",
    cursor: "pointer",
  },
  sizeInput: {
    width: "28px",
    height: "22px",
    fontSize: "11px",
    textAlign: "center",
    fontWeight: "600",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
    outline: "none",
  },
  btnIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "22px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  ribbonActionBtn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "4px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    height: "36px",
    minWidth: "60px",
  },
  btnLabel: {
    fontSize: "8.5px",
    fontWeight: "600",
    marginTop: "2px",
  },
  colorPickerWrapper: {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
    gap: "2px",
  },
  colorInput: {
    border: "none",
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    cursor: "pointer",
    padding: 0,
    outline: "none",
    background: "transparent",
  },
  horizontalRuler: {
    height: "14px",
    backgroundColor: "var(--bg-tertiary)",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    position: "relative",
    userSelect: "none",
  },
  rulerMarginStart: {
    width: "96px",
    backgroundColor: "var(--border)",
    opacity: 0.35,
  },
  rulerMarginEnd: {
    width: "96px",
    backgroundColor: "var(--border)",
    opacity: 0.35,
  },
  rulerCenterTicks: {
    flex: 1,
    display: "flex",
    justifyContent: "space-between",
    padding: "0 24px",
  },
  rulerMarker: {
    borderLeft: "1px solid var(--text-tertiary)",
    height: "6px",
    marginTop: "8px",
    position: "relative",
    width: "11%",
  },
  rulerNumber: {
    fontSize: "8px",
    position: "absolute",
    top: "-7px",
    left: "-3px",
    color: "var(--text-tertiary)",
  },
  workspaceContainer: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  verticalRuler: {
    width: "14px",
    backgroundColor: "var(--bg-tertiary)",
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    userSelect: "none",
  },
  vRulerMarginStart: {
    height: "96px",
    backgroundColor: "var(--border)",
    opacity: 0.35,
  },
  vRulerCenterTicks: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "24px 0",
    alignItems: "flex-end",
  },
  vRulerMarker: {
    borderTop: "1px solid var(--text-tertiary)",
    width: "6px",
    marginRight: "0",
    position: "relative",
    height: "8%",
  },
  vRulerNumber: {
    fontSize: "8px",
    position: "absolute",
    left: "-10px",
    top: "-5px",
    color: "var(--text-tertiary)",
  },
  paperViewport: {
    flex: 1,
    overflowY: "auto",
    padding: "24px 12px",
    display: "flex",
    justifyContent: "center",
    backgroundColor: "var(--bg-primary)",
  },
  paper: {
    width: "100%",
    maxWidth: "800px",
    minHeight: "1050px",
    height: "fit-content",
    backgroundColor: "white",
    color: "#0f172a",
    padding: "96px", // Standard margins (1 inch = 96px)
    boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.04), 0 8px 10px -6px rgba(0, 0, 0, 0.04), 0 0 0 1px rgba(0, 0, 0, 0.02)",
    borderRadius: "1px",
    outline: "none",
    fontSize: "14px",
    lineHeight: "1.5",
    fontFamily: "var(--font-sans)",
    textAlign: "left",
    position: "relative",
  },
  statusBar: {
    display: "flex",
    alignItems: "center",
    height: "30px",
    padding: "0 16px",
    backgroundColor: "var(--bg-secondary)",
    borderTop: "1px solid var(--border)",
    fontSize: "11px",
    color: "var(--text-secondary)",
  },
  statusItem: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  statusBarDot: {
    margin: "0 4px",
    color: "var(--text-tertiary)",
  }
};
