/** What the finance chat writes inside a ```chart block. */
export interface ChartSpec {
  type?: "line" | "bar";
  title?: string;
  x: string;
  series: string[];
  unit?: string;
  data: Record<string, string | number>[];
}

/** Returns the spec when the block is complete, valid JSON; null while it is still streaming. */
export function parseChartSpec(code: string): ChartSpec | null {
  try {
    const s = JSON.parse(code);
    if (!s || typeof s.x !== "string" || !Array.isArray(s.series) || !Array.isArray(s.data) || s.data.length === 0) return null;
    return s;
  } catch {
    return null;
  }
}
