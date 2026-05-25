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
      colorClass: "text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/40",
      bgClass: "bg-emerald-50 dark:bg-emerald-950/20",
      icon: "📊",
    };
  }

  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext) ||
    mimeType.startsWith("image/")
  ) {
    return {
      category: "Image",
      colorClass: "text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-900/40",
      bgClass: "bg-blue-50 dark:bg-blue-950/20",
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
      colorClass: "text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-900/40",
      bgClass: "bg-amber-50 dark:bg-amber-950/20",
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
