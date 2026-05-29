import React, { useState, useEffect, useRef } from "react";
import { Check, FileCode, AlertTriangle } from "lucide-react";

const PRESETS = {
  flowchart: `graph TD
    A[Start] --> B{Is zWork Active?}
    B -- Yes --> C[Run local Sidecar API]
    B -- No --> D[Start Tauri App Launcher]
    C --> E[Fetch pricing & technical indicators]
    D --> E
    E --> F[Render Interactive Stock Chart]
    F --> G[End]`,
  sequence: `sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant DB
    
    User->>Frontend: Enter query: AAPL Stock Price
    Frontend->>Backend: POST /api/chat/stream
    Backend->>Backend: Fetch query2.finance.yahoo.com
    Backend->>Backend: Compute SMA, EMA, RSI, MACD
    Backend->>DB: Save metrics history
    Backend-->>Frontend: Stream Stock Tool Result
    Frontend-->>User: Render Candlestick SVG Chart`,
  state: `stateDiagram-v2
    [*] --> Idle
    Idle --> Loading : Load document template
    Loading --> Editing : Render WYSIWYG
    Editing --> Compiling : Click Compile Diagrams
    Compiling --> Editing : Rendered Mermaid SVG
    Compiling --> Error : Syntax Error
    Error --> Editing : Fix code
    Editing --> [*]`,
  class: `classDiagram
    class Artifact {
        +String id
        +String kind
        +String title
        +String content
        +update()
    }
    class Document {
        +String pageSetup
        +compileMermaid()
    }
    class Spreadsheet {
        +List rows
        +parseFormulas()
        +renderSVGChart()
    }
    Artifact <|-- Document
    Artifact <|-- Spreadsheet`
};

export function MermaidEditor() {
  const [activePreset, setActivePreset] = useState<keyof typeof PRESETS>("flowchart");
  const [code, setCode] = useState(PRESETS.flowchart);
  const [svgMarkup, setSvgMarkup] = useState("");
  const [compileError, setCompileError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const renderIndex = useRef(0);

  useEffect(() => {
    compileDiagram(code);
  }, [code]);

  const compileDiagram = async (diagramCode: string) => {
    setCompileError(null);
    try {
      if (!(window as any).mermaid) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Failed to load Mermaid CDN"));
          document.head.appendChild(script);
        });
        (window as any).mermaid.initialize({
          startOnLoad: false,
          theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
          securityLevel: "loose",
        });
      }

      const mermaid = (window as any).mermaid;
      renderIndex.current += 1;
      const uniqueId = `mermaid-svg-sandbox-${renderIndex.current}`;
      const { svg } = await mermaid.render(uniqueId, diagramCode);
      setSvgMarkup(svg);
    } catch (err: any) {
      console.error(err);
      const rawMsg = err?.message || String(err);
      setCompileError(rawMsg.includes("Parsing error") ? rawMsg.split("\n")[0] : "Syntax Error: Check your diagram markup connections.");
    }
  };

  const loadPreset = (name: keyof typeof PRESETS) => {
    setActivePreset(name);
    setCode(PRESETS[name]);
  };

  const copySVG = () => {
    navigator.clipboard.writeText(svgMarkup).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadSVG = () => {
    const blob = new Blob([svgMarkup], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activePreset}_diagram.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={styles.container}>
      {/* simplified, clean Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.presetsGroup}>
          {(["flowchart", "sequence", "state", "class"] as const).map((preset) => (
            <button 
              key={preset}
              style={{ ...styles.presetBtn, ...(activePreset === preset ? styles.presetBtnActive : {}) }}
              onClick={() => loadPreset(preset)}
            >
              {preset}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <button style={styles.actionBtn} onClick={copySVG} disabled={!svgMarkup}>
          {copied ? <Check size={13} style={{ color: "#10b981" }} /> : <FileCode size={13} />}
          <span>{copied ? "Copied" : "Copy SVG"}</span>
        </button>

        <button style={styles.actionBtn} onClick={downloadSVG} disabled={!svgMarkup}>
          <span>Download SVG</span>
        </button>
      </div>

      {/* Decluttered Side-by-side split Editor */}
      <div style={styles.editorSplitLayout}>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Type your Mermaid syntax here..."
          spellCheck={false}
          style={styles.textarea}
        />

        <div style={styles.previewCol}>
          {compileError ? (
            <div style={styles.errorBox}>
              <AlertTriangle size={20} style={{ color: "#ef4444", marginBottom: 8 }} />
              <p style={{ fontSize: 11.5, color: "#ef4444", lineHeight: "1.4" }}>{compileError}</p>
            </div>
          ) : svgMarkup ? (
            <div 
              dangerouslySetInnerHTML={{ __html: svgMarkup }} 
              style={styles.svgContainer}
            />
          ) : (
            <div style={styles.emptyBox}>
              <span>Rendering diagram...</span>
            </div>
          )}
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
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 16px",
    backgroundColor: "var(--bg-secondary)",
    borderBottom: "1px solid var(--border)",
    zIndex: 10,
  },
  presetsGroup: {
    display: "flex",
    backgroundColor: "var(--bg-tertiary)",
    borderRadius: "var(--radius-sm)",
    padding: "2px",
    border: "1px solid var(--border)",
  },
  presetBtn: {
    padding: "4px 10px",
    fontSize: "11px",
    fontWeight: "500",
    border: "none",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    textTransform: "capitalize",
  },
  presetBtnActive: {
    backgroundColor: "var(--bg-secondary)",
    color: "var(--accent)",
    fontWeight: "600",
  },
  actionBtn: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 10px",
    fontSize: "11.5px",
    fontWeight: "500",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-secondary)",
    cursor: "pointer",
  },
  editorSplitLayout: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  textarea: {
    width: "40%",
    resize: "none",
    border: "none",
    borderRight: "1px solid var(--border)",
    outline: "none",
    padding: "16px",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    lineHeight: "1.6",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--text-primary)",
  },
  previewCol: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--bg-primary)",
    overflow: "auto",
    padding: "24px",
  },
  svgContainer: {
    width: "100%",
    maxWidth: "520px",
    backgroundColor: "var(--bg-secondary)",
    padding: "20px",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-sm)",
    border: "1px solid var(--border)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  errorBox: {
    backgroundColor: "rgba(239, 68, 68, 0.05)",
    border: "1px solid rgba(239, 68, 68, 0.2)",
    borderRadius: "var(--radius-sm)",
    padding: "12px 16px",
    maxWidth: "360px",
    textAlign: "center",
  },
  emptyBox: {
    fontSize: "11.5px",
    color: "var(--text-tertiary)",
  }
};
