export interface FileClassification {
  category: "Document" | "Spreadsheet" | "Code" | "Image";
  colorClass: string;
  bgClass: string;
  icon: string;
}

export function classifyFile(name: string, mime?: string): FileClassification {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const mimeType = mime?.toLowerCase() || "";

  if (
    ["csv", "tsv", "xlsx", "xls", "ods"].includes(ext) ||
    mimeType.includes("spreadsheet") ||
    mimeType === "text/csv" ||
    mimeType === "text/tab-separated-values"
  ) {
    return {
      category: "Spreadsheet",
      colorClass: "text-success border-success/30",
      bgClass: "bg-success/10",
      icon: "📊",
    };
  }

  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext) ||
    mimeType.startsWith("image/")
  ) {
    return {
      category: "Image",
      colorClass: "text-info border-info/30",
      bgClass: "bg-info/10",
      icon: "🖼️",
    };
  }

  if (
    ["py", "js", "jsx", "ts", "tsx", "html", "css", "json", "yaml", "yml", "xml", "sh", "rs", "go", "c", "cpp", "h", "java", "sql"].includes(ext) ||
    mimeType.startsWith("text/x-") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript"
  ) {
    return {
      category: "Code",
      colorClass: "text-warning border-warning/30",
      bgClass: "bg-warning/10",
      icon: "💻",
    };
  }

  // Default to Document
  return {
    category: "Document",
    colorClass: "text-ink-soft border-line",
    bgClass: "bg-paper-sunken/40",
    icon: "📄",
  };
}
