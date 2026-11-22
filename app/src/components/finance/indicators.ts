/**
 * Chart indicators, computed on the closes we already have. Each returns one value
 * per input point, null until there is enough history. Dependency-free so
 * app/scripts/finance-selfcheck.ts can test it with node.
 */
export type Series = (number | null)[];

export function sma(values: number[], n: number): Series {
  let sum = 0;
  return values.map((v, i) => {
    sum += v;
    if (i >= n) sum -= values[i - n];
    return i >= n - 1 ? sum / n : null;
  });
}

export function ema(values: number[], n: number): Series {
  const k = 2 / (n + 1);
  let prev: number | null = null;
  return values.map((v, i) => {
    if (i < n - 1) return null;
    // Seed with the simple average of the first n values.
    prev = prev == null ? values.slice(0, n).reduce((a, b) => a + b, 0) / n : v * k + prev * (1 - k);
    return prev;
  });
}

/** Wilder's RSI. */
export function rsi(values: number[], n = 14): Series {
  const out: Series = values.map(() => null);
  if (values.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9): { macd: Series; signal: Series; hist: Series } {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
  const start = line.findIndex((v) => v != null);
  const sig: Series = values.map(() => null);
  if (start >= 0) {
    const e = ema(line.slice(start) as number[], signal);
    e.forEach((v, i) => (sig[start + i] = v));
  }
  return { macd: line, signal: sig, hist: line.map((v, i) => (v != null && sig[i] != null ? v - (sig[i] as number) : null)) };
}

export function bollinger(values: number[], n = 20, k = 2): { mid: Series; upper: Series; lower: Series } {
  const mid = sma(values, n);
  const sd = values.map((_, i) => {
    if (i < n - 1) return null;
    const w = values.slice(i - n + 1, i + 1);
    const m = mid[i] as number;
    return Math.sqrt(w.reduce((a, v) => a + (v - m) ** 2, 0) / n);
  });
  return {
    mid,
    upper: mid.map((m, i) => (m != null ? m + k * (sd[i] as number) : null)),
    lower: mid.map((m, i) => (m != null ? m - k * (sd[i] as number) : null)),
  };
}
