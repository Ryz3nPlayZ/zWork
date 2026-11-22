/**
 * The price chart: candles or a line, volume underneath, a crosshair readout,
 * optional indicators (moving averages, Bollinger bands, RSI, MACD) and, for
 * Compare, several symbols overlaid as percent change.
 * lightweight-charts draws on canvas, so colors are read from the theme tokens
 * and the chart is rebuilt when the theme changes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { FinanceCandle, FinanceChart } from "../../lib/api";
import { bollinger, ema, macd, rsi, sma, type Series } from "./indicators";
import { big, cssColor, price, useThemeKey } from "./ui";

export type Indicator = "sma20" | "sma50" | "sma200" | "ema20" | "bb" | "rsi" | "macd";
export const INDICATORS: { value: Indicator; label: string }[] = [
  { value: "sma20", label: "20-day average" },
  { value: "sma50", label: "50-day average" },
  { value: "sma200", label: "200-day average" },
  { value: "ema20", label: "20-day EMA" },
  { value: "bb", label: "Bollinger bands" },
  { value: "rsi", label: "RSI" },
  { value: "macd", label: "MACD" },
];
/** Series colors for compare lines and indicators, as theme token names. */
const PALETTE = ["info", "warning", "accent", "success", "error"];

// lightweight-charts shows UTC; shift by the local offset so the axis reads in local time.
const local = (t: number) => (t - new Date(t * 1000).getTimezoneOffset() * 60) as UTCTimestamp;

/** Ascending, unique times; the library throws on repeats. */
function clean(points: FinanceCandle[]) {
  const out: FinanceCandle[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.c)) continue;
    if (out.length && p.t <= out[out.length - 1].t) continue;
    out.push(p);
  }
  return out;
}

const NONE: FinanceChart[] = [];
const line = (pts: FinanceCandle[], s: Series) =>
  pts.flatMap((p, i) => (s[i] == null ? [] : [{ time: local(p.t), value: s[i] as number }]));

interface Props {
  chart: FinanceChart;
  compare?: FinanceChart[];
  kind?: "candle" | "line";
  indicators?: Indicator[];
  height?: number;
}

export function CandleChart({ chart, compare = NONE, kind = "candle", indicators = [], height = 320 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const api = useRef<IChartApi | null>(null);
  const theme = useThemeKey();
  const [hover, setHover] = useState<FinanceCandle | null>(null);
  const pts = useMemo(() => clean(chart.points), [chart.points]);
  const intraday = chart.range === "1d" || chart.range === "5d";
  const comparing = compare.length > 0;
  const ind = indicators.join(",");
  // Callers rebuild arrays each render; key on what's in them so the chart isn't recreated every time.
  const cmpKey = compare.map((c) => `${c.symbol}:${c.range}:${c.points.length}`).join(",");

  useEffect(() => {
    const el = box.current;
    if (!el || pts.length < 2) return;
    const ink = cssColor("ink-muted");
    const grid = cssColor("line-soft", 0.6);
    const upC = cssColor("success");
    const downC = cssColor("error");
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: ink, fontSize: 11, fontFamily: getComputedStyle(document.body).fontFamily, panes: { separatorColor: grid } },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      rightPriceScale: { borderVisible: false, mode: comparing ? PriceScaleMode.Percentage : PriceScaleMode.Normal },
      timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false, rightOffset: 2 },
      crosshair: { vertLine: { color: cssColor("ink-faint", 0.6), labelBackgroundColor: cssColor("ink-soft") }, horzLine: { color: cssColor("ink-faint", 0.6), labelBackgroundColor: cssColor("ink-soft") } },
      localization: { priceFormatter: (p: number) => (comparing ? `${p.toFixed(1)}%` : price(p)) },
    });
    api.current = c;
    const closes = pts.map((p) => p.c);
    const last = closes[closes.length - 1];
    const base = chart.range === "1d" ? chart.previousClose ?? closes[0] : closes[0];
    const trend = last >= base ? upC : downC;

    let main;
    if (comparing) {
      main = c.addSeries(LineSeries, { color: cssColor("ink"), lineWidth: 2, priceLineVisible: false, title: chart.symbol });
      main.setData(pts.map((p) => ({ time: local(p.t), value: p.c })));
      compare.forEach((other, i) => {
        const s = c.addSeries(LineSeries, { color: cssColor(PALETTE[i % PALETTE.length]), lineWidth: 2, priceLineVisible: false, title: other.symbol });
        s.setData(clean(other.points).map((p) => ({ time: local(p.t), value: p.c })));
      });
    } else if (kind === "candle" && !intraday) {
      main = c.addSeries(CandlestickSeries, { upColor: upC, downColor: downC, borderVisible: false, wickUpColor: upC, wickDownColor: downC, priceLineVisible: false });
      main.setData(pts.map((p) => ({ time: local(p.t), open: p.o, high: p.h, low: p.l, close: p.c })));
    } else {
      main = c.addSeries(AreaSeries, { lineColor: trend, lineWidth: 2, topColor: trend.replace(/[\d.]+\)$/, "0.18)"), bottomColor: trend.replace(/[\d.]+\)$/, "0)"), priceLineVisible: false });
      main.setData(pts.map((p) => ({ time: local(p.t), value: p.c })));
    }
    if (chart.range === "1d" && chart.previousClose != null && !comparing) {
      main.createPriceLine({ price: chart.previousClose, color: cssColor("ink-faint"), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "Prev close" });
    }

    if (!comparing && pts.some((p) => p.v > 0)) {
      const vol = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(pts.map((p, i) => ({ time: local(p.t), value: p.v, color: (i && p.c < pts[i - 1].c ? downC : upC).replace(/[\d.]+\)$/, "0.35)") })));
    }

    if (!comparing) {
      const overlay = (s: Series, color: string, width: 1 | 2 = 1) =>
        c.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(line(pts, s));
      if (indicators.includes("sma20")) overlay(sma(closes, 20), cssColor("info"));
      if (indicators.includes("sma50")) overlay(sma(closes, 50), cssColor("warning"));
      if (indicators.includes("sma200")) overlay(sma(closes, 200), cssColor("accent"));
      if (indicators.includes("ema20")) overlay(ema(closes, 20), cssColor("info", 0.7));
      if (indicators.includes("bb")) {
        const b = bollinger(closes);
        overlay(b.upper, cssColor("ink-faint", 0.8));
        overlay(b.mid, cssColor("ink-faint", 0.5));
        overlay(b.lower, cssColor("ink-faint", 0.8));
      }
      let pane = 1;
      if (indicators.includes("rsi")) {
        const s = c.addSeries(LineSeries, { color: cssColor("accent"), lineWidth: 1, priceLineVisible: false, title: "RSI 14" }, pane);
        s.setData(line(pts, rsi(closes)));
        s.createPriceLine({ price: 70, color: cssColor("ink-faint"), lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: "" });
        s.createPriceLine({ price: 30, color: cssColor("ink-faint"), lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: "" });
        pane++;
      }
      if (indicators.includes("macd")) {
        const m = macd(closes);
        c.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane).setData(
          pts.flatMap((p, i) => (m.hist[i] == null ? [] : [{ time: local(p.t), value: m.hist[i] as number, color: ((m.hist[i] as number) >= 0 ? upC : downC).replace(/[\d.]+\)$/, "0.5)") }])),
        );
        c.addSeries(LineSeries, { color: cssColor("info"), lineWidth: 1, priceLineVisible: false, title: "MACD" }, pane).setData(line(pts, m.macd));
        c.addSeries(LineSeries, { color: cssColor("warning"), lineWidth: 1, priceLineVisible: false, title: "Signal" }, pane).setData(line(pts, m.signal));
        pane++;
      }
      c.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
    }

    const byTime = new Map(pts.map((p) => [local(p.t) as number, p]));
    c.subscribeCrosshairMove((e) => setHover(e.time == null ? null : byTime.get(e.time as number) ?? null));
    c.timeScale().fitContent();
    return () => {
      c.remove();
      api.current = null;
      setHover(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, cmpKey, kind, ind, theme, intraday, comparing, chart.range, chart.previousClose, chart.symbol]);

  const shown = hover ?? pts[pts.length - 1];
  const panes = comparing ? 0 : (indicators.includes("rsi") ? 1 : 0) + (indicators.includes("macd") ? 1 : 0);
  const when = (t: number) =>
    new Date(t * 1000).toLocaleString(undefined, intraday ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { dateStyle: "medium" });

  if (pts.length < 2) return <p className="py-16 text-center text-[12.5px] text-ink-muted">Not enough prices to draw this range.</p>;
  return (
    <div className="relative">
      {shown && !comparing && (
        <div className="pointer-events-none absolute left-1 top-0 z-10 flex flex-wrap gap-x-3 text-[11.5px] tabular-nums text-ink-muted">
          <span className="text-ink-faint">{when(shown.t)}</span>
          <span>O {price(shown.o)}</span>
          <span>H {price(shown.h)}</span>
          <span>L {price(shown.l)}</span>
          <span className="text-ink">C {price(shown.c)}</span>
          {shown.v > 0 && <span>Vol {big(shown.v)}</span>}
        </div>
      )}
      {comparing && (
        <div className="pointer-events-none absolute left-1 top-0 z-10 flex flex-wrap gap-x-3 text-[11.5px]">
          {[chart, ...compare].map((c, i) => (
            <span key={c.symbol} className="inline-flex items-center gap-1 text-ink-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: i === 0 ? "rgb(var(--ink))" : `rgb(var(--${PALETTE[(i - 1) % PALETTE.length]}))` }} />
              {c.symbol}
            </span>
          ))}
        </div>
      )}
      <div ref={box} style={{ height: height + panes * 90 }} className="pt-5" />
    </div>
  );
}
