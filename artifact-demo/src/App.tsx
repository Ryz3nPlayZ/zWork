import { useState } from "react";
import { FileText, LayoutGrid, TrendingUp, Share2, Sparkles, Laptop } from "lucide-react";
import { DocumentEditor } from "./components/DocumentEditor";
import { SpreadsheetEditor } from "./components/SpreadsheetEditor";
import { StockChartViewer } from "./components/StockChartViewer";
import { MermaidEditor } from "./components/MermaidEditor";

type Tab = "doc" | "sheet" | "stock" | "mermaid";

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("doc");

  return (
    <div style={styles.container}>
      {/* Top Header Bar */}
      <header style={styles.header}>
        <div style={styles.headerLogo}>
          <Laptop size={18} style={styles.logoIcon} />
          <span style={styles.headerTitle}>zWork Artifact Workspace Playground</span>
          <span style={styles.badge}>v0.4.0-alpha.23</span>
        </div>
        <div style={styles.tagline}>
          <Sparkles size={12} style={{ color: "var(--accent)" }} />
          <span>Interactive Canvas & Stock Trading Client Prototype</span>
        </div>
      </header>

      {/* Main Workspace split */}
      <div style={styles.main}>
        {/* Sidebar Navigation */}
        <aside style={styles.sidebar}>
          <nav style={styles.nav}>
            <button 
              style={{ ...styles.navItem, ...(activeTab === "doc" ? styles.navItemActive : {}) }}
              onClick={() => setActiveTab("doc")}
            >
              <FileText size={16} />
              <div style={styles.navLabelGroup}>
                <span style={styles.navLabel}>Document Canvas</span>
                <span style={styles.navSublabel}>Google Docs WYSIWYG</span>
              </div>
            </button>

            <button 
              style={{ ...styles.navItem, ...(activeTab === "sheet" ? styles.navItemActive : {}) }}
              onClick={() => setActiveTab("sheet")}
            >
              <LayoutGrid size={16} />
              <div style={styles.navLabelGroup}>
                <span style={styles.navLabel}>spreadsheet Grid</span>
                <span style={styles.navSublabel}>Excel Formulas & Charts</span>
              </div>
            </button>

            <button 
              style={{ ...styles.navItem, ...(activeTab === "stock" ? styles.navItemActive : {}) }}
              onClick={() => setActiveTab("stock")}
            >
              <TrendingUp size={16} />
              <div style={styles.navLabelGroup}>
                <span style={styles.navLabel}>Stock Technicals</span>
                <span style={styles.navSublabel}>Technical SVG Charts</span>
              </div>
            </button>

            <button 
              style={{ ...styles.navItem, ...(activeTab === "mermaid" ? styles.navItemActive : {}) }}
              onClick={() => setActiveTab("mermaid")}
            >
              <Share2 size={16} />
              <div style={styles.navLabelGroup}>
                <span style={styles.navLabel}>Mermaid Diagram</span>
                <span style={styles.navSublabel}>Live Vector Sandbox</span>
              </div>
            </button>
          </nav>
          
          <div style={styles.sidebarFooter}>
            <p style={{ fontWeight: 600, color: "var(--text-primary)" }}>zWork Platform</p>
            <p>Seeded Mock Analytics Engine</p>
          </div>
        </aside>

        {/* Dynamic Workspace Container */}
        <main style={styles.workspace}>
          {activeTab === "doc" && <DocumentEditor />}
          {activeTab === "sheet" && <SpreadsheetEditor />}
          {activeTab === "stock" && <StockChartViewer />}
          {activeTab === "mermaid" && <MermaidEditor />}
        </main>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100vw",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: "48px",
    backgroundColor: "var(--bg-secondary)",
    borderBottom: "1px solid var(--border)",
    padding: "0 18px",
    zIndex: 100,
    boxShadow: "var(--shadow-sm)",
  },
  headerLogo: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  logoIcon: {
    color: "var(--accent)",
  },
  headerTitle: {
    fontWeight: "700",
    fontSize: "14.5px",
    color: "var(--text-primary)",
    letterSpacing: "-0.2px",
  },
  badge: {
    fontSize: "10px",
    fontWeight: "bold",
    backgroundColor: "var(--accent-light)",
    color: "var(--accent)",
    padding: "2px 6px",
    borderRadius: "20px",
  },
  tagline: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "11px",
    fontWeight: "500",
    color: "var(--text-secondary)",
  },
  main: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  sidebar: {
    width: "240px",
    backgroundColor: "var(--bg-secondary)",
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "16px 12px",
    zIndex: 10,
  },
  nav: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px 14px",
    border: "1px solid transparent",
    borderRadius: "var(--radius-md)",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
    textAlign: "left",
    transition: "all 0.15s ease",
    width: "100%",
  },
  navItemActive: {
    backgroundColor: "var(--bg-primary)",
    borderColor: "var(--border)",
    color: "var(--accent)",
    fontWeight: "bold",
    boxShadow: "var(--shadow-sm)",
  },
  navLabelGroup: {
    display: "flex",
    flexDirection: "column",
  },
  navLabel: {
    fontSize: "13px",
    fontWeight: "600",
  },
  navSublabel: {
    fontSize: "10px",
    color: "var(--text-tertiary)",
    fontWeight: "normal",
    marginTop: "1px",
  },
  sidebarFooter: {
    fontSize: "10.5px",
    color: "var(--text-tertiary)",
    lineHeight: "1.4",
    padding: "8px 12px",
    borderTop: "1px dashed var(--border)",
  },
  workspace: {
    flex: 1,
    overflow: "hidden",
    position: "relative",
    backgroundColor: "var(--bg-primary)",
  }
};
