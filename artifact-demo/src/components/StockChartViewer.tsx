import React, { useState, useMemo } from "react";

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Technical drawing interfaces
interface LineDrawing {
  id: string;
  type: "trend" | "horizontal";
  p1: { idx: number; price: number };
  p2?: { idx: number; price: number }; // Optional for horizontal lines
}

// Technical indicator helpers
function calcSMA(prices: number[], period: number): (number | null)[] {
  const sma: (number | null)[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) sma.push(null);
    else sma.push(prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return sma;
}

function calcEMA(prices: number[], period: number): (number | null)[] {
  const ema: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prevEma: number | null = null;
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) ema.push(null);
    else if (i === period - 1) {
      prevEma = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      ema.push(prevEma);
    } else {
      if (prevEma !== null) {
        prevEma = prices[i] * k + prevEma * (1 - k);
        ema.push(prevEma);
      } else ema.push(null);
    }
  }
  return ema;
}

function calcRSI(prices: number[], period: number = 14): (number | null)[] {
  const rsi: (number | null)[] = [];
  if (prices.length < period) return Array(prices.length).fill(null);
  let gains: number[] = [];
  let losses: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = 0; i < period; i++) rsi.push(null);
  rsi.push(100 - 100 / (1 + (avgGain / (avgLoss || 1))));

  for (let i = period + 1; i < prices.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
    rsi.push(100 - 100 / (1 + (avgGain / (avgLoss || 1))));
  }
  return rsi;
}

function calcMACD(prices: number[]): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macd: (number | null)[] = [];
  for (let i = 0; i < prices.length; i++) {
    const e12 = ema12[i];
    const e26 = ema26[i];
    macd.push(e12 !== null && e26 !== null ? e12 - e26 : null);
  }
  const validMacd = macd.filter((x): x is number => x !== null);
  const signalValid = calcEMA(validMacd, 9);
  const signal: (number | null)[] = [];
  const hist: (number | null)[] = [];
  let validIdx = 0;
  for (let i = 0; i < prices.length; i++) {
    if (macd[i] === null) {
      signal.push(null);
      hist.push(null);
    } else {
      const sigVal = signalValid[validIdx];
      const macdVal = macd[i];
      if (sigVal !== null && sigVal !== undefined && macdVal !== null) {
        signal.push(sigVal);
        hist.push(macdVal - sigVal);
      } else {
        signal.push(null);
        hist.push(null);
      }
      validIdx++;
    }
  }
  return { macd, signal, hist };
}

// Bollinger Bands calculator
function calcBollingerBands(prices: number[], period: number = 20, multiplier: number = 2) {
  const sma = calcSMA(prices, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < prices.length; i++) {
    const mean = sma[i];
    if (mean === null) {
      upper.push(null);
      lower.push(null);
    } else {
      const variance = prices.slice(i - period + 1, i + 1).reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      upper.push(mean + multiplier * stdDev);
      lower.push(mean - multiplier * stdDev);
    }
  }
  return { upper, lower };
}

function generateMockStockData(ticker: string, days: number): Candle[] {
  let basePrice = { AAPL: 175.0, TSLA: 180.0, NVDA: 120.0, AMZN: 185.0, MSFT: 415.0 }[ticker] || 150.0;
  const data: Candle[] = [];
  let price = basePrice;
  const now = new Date();
  let seed = { AAPL: 1, TSLA: 2, NVDA: 3, AMZN: 4, MSFT: 5 }[ticker] || 9;
  const rand = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };
  for (let i = days; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const change = (rand() - 0.48) * (price * 0.035);
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + rand() * (price * 0.015);
    const low = Math.min(open, close) - rand() * (price * 0.015);
    const volume = Math.round(50000000 + rand() * 80000000);
    data.push({
      date: date.toISOString().split("T")[0],
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    });
    price = close;
  }
  return data;
}

export function StockChartViewer() {
  const [ticker, setTicker] = useState("AAPL");
  const [timeRange, setTimeRange] = useState<"30" | "60" | "90">("60");
  
  // overlays State
  const [showSMA, setShowSMA] = useState(true);
  const [showEMA, setShowEMA] = useState(false);
  const [showBands, setShowBands] = useState(true); // Bollinger Bands
  const [showRSI, setShowRSI] = useState(true);
  const [showMACD, setShowMACD] = useState(true);

  // Drawings toolbar state
  const [activeTool, setActiveTool] = useState<"cursor" | "trend" | "horizontal">("cursor");
  const [drawings, setDrawings] = useState<LineDrawing[]>([]);
  const [partialDraw, setPartialDraw] = useState<LineDrawing["p1"] | null>(null);

  // Interactive hovering crosshairs
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverYPrice, setHoverYPrice] = useState<number | null>(null);

  const historyData = useMemo(() => {
    const candles = generateMockStockData(ticker, parseInt(timeRange) + 40);
    const sliced = candles.slice(-parseInt(timeRange));
    const closePrices = candles.map(c => c.close);
    
    const sma20Full = calcSMA(closePrices, 20);
    const ema20Full = calcEMA(closePrices, 20);
    const rsi14Full = calcRSI(closePrices, 14);
    const macdFull = calcMACD(closePrices);
    const bandsFull = calcBollingerBands(closePrices, 20, 2);

    const bufferSize = candles.length - sliced.length;
    return {
      candles: sliced,
      sma20: sma20Full.slice(bufferSize),
      ema20: ema20Full.slice(bufferSize),
      rsi14: rsi14Full.slice(bufferSize),
      macd: macdFull.macd.slice(bufferSize),
      macdSignal: macdFull.signal.slice(bufferSize),
      macdHist: macdFull.hist.slice(bufferSize),
      bandsUpper: bandsFull.upper.slice(bufferSize),
      bandsLower: bandsFull.lower.slice(bufferSize),
    };
  }, [ticker, timeRange]);

  const currentCandle = historyData.candles[historyData.candles.length - 1];
  const prevCandle = historyData.candles[historyData.candles.length - 2];
  const priceChange = currentCandle.close - prevCandle.close;
  const pctChange = (priceChange / prevCandle.close) * 100;

  const activeCandle = hoverIndex !== null ? historyData.candles[hoverIndex] : currentCandle;
  const activeSma = hoverIndex !== null ? historyData.sma20[hoverIndex] : historyData.sma20[historyData.sma20.length - 1];
  const activeEma = hoverIndex !== null ? historyData.ema20[hoverIndex] : historyData.ema20[historyData.ema20.length - 1];
  const activeRsi = hoverIndex !== null ? historyData.rsi14[hoverIndex] : historyData.rsi14[historyData.rsi14.length - 1];
  const activeMacd = hoverIndex !== null ? historyData.macd[hoverIndex] : historyData.macd[historyData.macd.length - 1];

  const techSignals = useMemo(() => {
    const rsiVal = activeRsi || 50;
    const macdVal = activeMacd || 0;
    let rsiSignal = "Neutral";
    if (rsiVal > 70) rsiSignal = "Overbought (SELL)";
    else if (rsiVal < 30) rsiSignal = "Oversold (BUY)";

    const macdSignal = macdVal > 0 ? "Bullish (BUY)" : "Bearish (SELL)";
    const overall = (rsiVal > 70 && macdVal < 0) ? "STRONG SELL" : (rsiVal < 30 && macdVal > 0) ? "STRONG BUY" : (macdVal > 0 ? "BUY" : "SELL");
    
    return { rsiSignal, macdSignal, overall };
  }, [activeRsi, activeMacd]);

  // Price dimensions
  const svgWidth = 640;
  const svgHeight = 240;
  const paddingRight = 50;
  const paddingTop = 15;
  const paddingBottom = 20;
  const chartWidth = svgWidth - paddingRight;
  const chartHeight = svgHeight - paddingTop - paddingBottom;
  
  const maxPrice = Math.max(...historyData.candles.map(c => c.high)) * 1.01;
  const minPrice = Math.min(...historyData.candles.map(c => c.low)) * 0.99;
  const priceRangeDiff = maxPrice - minPrice;

  const getX = (index: number) => (index / (historyData.candles.length - 1)) * (chartWidth - 20) + 10;
  const getY = (price: number) => chartHeight - ((price - minPrice) / priceRangeDiff) * chartHeight + paddingTop;
  
  // Reverse SVG coordinate Y back to stock price value
  const getPriceFromY = (yVal: number) => {
    const yRatio = (chartHeight - yVal + paddingTop) / chartHeight;
    return minPrice + yRatio * priceRangeDiff;
  };

  // Generate SVG Line Paths
  const generateLinePath = (data: (number | null)[]) => {
    return data
      .map((val, idx) => {
        if (val === null) return "";
        const x = getX(idx);
        const y = getY(val);
        return `${idx === 0 || data[idx - 1] === null ? "M" : "L"} ${x} ${y}`;
      })
      .join(" ");
  };

  // Bollinger bands shaded polygon area generator
  const bandsPolygonPoints = useMemo(() => {
    const pointsUpper: string[] = [];
    const pointsLower: string[] = [];

    historyData.bandsUpper.forEach((val, idx) => {
      if (val !== null) pointsUpper.push(`${getX(idx)},${getY(val)}`);
    });
    // Traverse lower backwards to complete the polygon loop
    historyData.bandsLower.slice().reverse().forEach((val, idx) => {
      if (val !== null) {
        const reverseIdx = historyData.bandsLower.length - 1 - idx;
        pointsLower.push(`${getX(reverseIdx)},${getY(val)}`);
      }
    });

    return [...pointsUpper, ...pointsLower].join(" ");
  }, [historyData, priceRangeDiff]);

  // RSI layouts
  const rsiHeight = 80;
  const getRsiY = (val: number) => rsiHeight - (val / 100) * (rsiHeight - 16) - 8;

  // MACD layouts
  const macdHeight = 80;
  const maxMacd = Math.max(...historyData.macd.concat(historyData.macdSignal).map(v => Math.abs(v || 0)), 1);
  const getMacdY = (val: number) => macdHeight / 2 - (val / maxMacd) * (macdHeight / 2 - 8);

  // Click handler to draw lines
  const handleChartClick = () => {
    if (activeTool === "cursor" || hoverIndex === null || hoverYPrice === null) return;

    if (activeTool === "horizontal") {
      const newHorizontal: LineDrawing = {
        id: `draw_${Date.now()}`,
        type: "horizontal",
        p1: { idx: hoverIndex, price: hoverYPrice }
      };
      setDrawings(prev => [...prev, newHorizontal]);
      setActiveTool("cursor");
    } else if (activeTool === "trend") {
      if (!partialDraw) {
        setPartialDraw({ idx: hoverIndex, price: hoverYPrice });
      } else {
        const newTrend: LineDrawing = {
          id: `draw_${Date.now()}`,
          type: "trend",
          p1: partialDraw,
          p2: { idx: hoverIndex, price: hoverYPrice }
        };
        setDrawings(prev => [...prev, newTrend]);
        setPartialDraw(null);
        setActiveTool("cursor");
      }
    }
  };

  const clearDrawings = () => {
    setDrawings([]);
    setPartialDraw(null);
  };

  return (
    <div style={styles.container}>
      {/* TradingView-style dark headers */}
      <div style={styles.header}>
        <div style={styles.headerTitleGroup}>
          <select 
            style={styles.tickerSelect} 
            value={ticker} 
            onChange={(e) => {
              setTicker(e.target.value);
              setHoverIndex(null);
              setDrawings([]);
            }}
          >
            <option value="AAPL">AAPL (Apple Inc.)</option>
            <option value="TSLA">TSLA (Tesla Inc.)</option>
            <option value="NVDA">NVDA (NVIDIA Corp.)</option>
            <option value="AMZN">AMZN (Amazon Corp.)</option>
            <option value="MSFT">MSFT (Microsoft Corp.)</option>
          </select>
          <div style={styles.priceContainer}>
            <span style={styles.priceLabel}>${currentCandle.close}</span>
            <span style={{ 
              ...styles.changeLabel, 
              color: priceChange >= 0 ? "#00e676" : "#ff1744" 
            }}>
              {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)} ({priceChange >= 0 ? "+" : ""}{pctChange.toFixed(2)}%)
            </span>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {/* Range Switches */}
        <div style={styles.timeGroup}>
          {(["30", "60", "90"] as const).map(range => (
            <button 
              key={range}
              style={{ ...styles.timeBtn, ...(timeRange === range ? styles.timeBtnActive : {}) }}
              onClick={() => {
                setTimeRange(range);
                setHoverIndex(null);
              }}
            >
              {range}d Range
            </button>
          ))}
        </div>
      </div>

      {/* Indicator overlay selections */}
      <div style={styles.toolbar}>
        <span style={styles.toolbarTitle}>Terminal indicators:</span>
        <label style={styles.checkboxLabel}>
          <input type="checkbox" checked={showSMA} onChange={(e) => setShowSMA(e.target.checked)} style={styles.checkbox} />
          <span style={{ color: "#2196f3" }}>SMA 20</span>
        </label>
        <label style={styles.checkboxLabel}>
          <input type="checkbox" checked={showEMA} onChange={(e) => setShowEMA(e.target.checked)} style={styles.checkbox} />
          <span style={{ color: "#ff9800" }}>EMA 20</span>
        </label>
        <label style={styles.checkboxLabel}>
          <input type="checkbox" checked={showBands} onChange={(e) => setShowBands(e.target.checked)} style={styles.checkbox} />
          <span style={{ color: "#00bcd4" }}>Bollinger Bands (20,2)</span>
        </label>
        <div style={styles.divider} />
        <label style={styles.checkboxLabel}>
          <input type="checkbox" checked={showRSI} onChange={(e) => setShowRSI(e.target.checked)} style={styles.checkbox} />
          <span style={{ color: "#e040fb" }}>RSI Panel</span>
        </label>
        <label style={styles.checkboxLabel}>
          <input type="checkbox" checked={showMACD} onChange={(e) => setShowMACD(e.target.checked)} style={styles.checkbox} />
          <span style={{ color: "#00e676" }}>MACD Panel</span>
        </label>
      </div>

      <div style={styles.viewportLayout}>
        {/* Left Side Drawings Toolbar (Trendlines/Horizontal Alerts) */}
        <div style={styles.drawingToolbar}>
          <button 
            style={{ ...styles.drawBtn, ...(activeTool === "cursor" ? styles.drawBtnActive : {}) }}
            onClick={() => { setActiveTool("cursor"); setPartialDraw(null); }}
            title="Standard Cursor"
          >
            Cursor
          </button>
          <button 
            style={{ ...styles.drawBtn, ...(activeTool === "trend" ? styles.drawBtnActive : {}) }}
            onClick={() => setActiveTool("trend")}
            title="Draw Trendline: Click two points on chart"
          >
            Trendline
          </button>
          <button 
            style={{ ...styles.drawBtn, ...(activeTool === "horizontal" ? styles.drawBtnActive : {}) }}
            onClick={() => { setActiveTool("horizontal"); setPartialDraw(null); }}
            title="Draw Horizontal Price Alert: Click price level"
          >
            Price Level
          </button>
          <div style={{ flex: 1 }} />
          <button 
            style={{ ...styles.drawBtn, color: "#ff1744" }}
            onClick={clearDrawings}
            title="Clear all drawings"
          >
            Clear
          </button>
        </div>

        {/* Charts block */}
        <div style={styles.chartCol}>
          {/* Candlestick Main Viewport */}
          <div style={styles.chartBox}>
            <div style={styles.chartLegend}>
              <span style={{ color: "#eceff1" }}>
                <strong>OHLC:</strong> O:{activeCandle.open} H:{activeCandle.high} L:{activeCandle.low} C:{activeCandle.close} Vol:{(activeCandle.volume/1000000).toFixed(1)}M
              </span>
              {showSMA && activeSma && <span style={{ color: "#2196f3", marginLeft: 8 }}>SMA:{activeSma.toFixed(2)}</span>}
              {showEMA && activeEma && <span style={{ color: "#ff9800", marginLeft: 8 }}>EMA:{activeEma.toFixed(2)}</span>}
            </div>

            <svg 
              viewBox={`0 0 ${svgWidth} ${svgHeight}`} 
              style={styles.svg}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                
                const ratio = x / rect.width;
                const idx = Math.min(
                  historyData.candles.length - 1, 
                  Math.max(0, Math.floor(ratio * historyData.candles.length))
                );
                
                // SVG height scale ratio
                const svgY = (y / rect.height) * svgHeight;
                
                setHoverIndex(idx);
                setHoverYPrice(parseFloat(getPriceFromY(svgY).toFixed(2)));
              }}
              onMouseLeave={() => {
                setHoverIndex(null);
                setHoverYPrice(null);
              }}
              onClick={handleChartClick}
            >
              {/* Bollinger Bands Shaded volatility polygon channel */}
              {showBands && historyData.bandsUpper[0] !== null && (
                <g>
                  <polygon points={bandsPolygonPoints} fill="rgba(0, 188, 212, 0.05)" />
                  <path d={generateLinePath(historyData.bandsUpper)} fill="none" stroke="rgba(0, 188, 212, 0.4)" strokeWidth={1} />
                  <path d={generateLinePath(historyData.bandsLower)} fill="none" stroke="rgba(0, 188, 212, 0.4)" strokeWidth={1} />
                </g>
              )}

              {/* Y Axis grids */}
              {Array.from({ length: 4 }).map((_, i) => {
                const price = maxPrice - (priceRangeDiff / 3) * i;
                const y = getY(price);
                return (
                  <g key={i}>
                    <line x1={0} y1={y} x2={chartWidth} y2={y} stroke="#1e293b" strokeWidth={0.5} strokeDasharray="3 3" />
                    <text x={chartWidth + 6} y={y + 3} fontSize={9} fill="#64748b">{price.toFixed(1)}</text>
                  </g>
                );
              })}

              {/* Candlesticks and Volumes */}
              {historyData.candles.map((candle, idx) => {
                const isBullish = candle.close >= candle.open;
                const x = getX(idx);
                const w = (chartWidth / historyData.candles.length) * 0.72;
                
                const yOpen = getY(candle.open);
                const yClose = getY(candle.close);
                const yHigh = getY(candle.high);
                const yLow = getY(candle.low);
                
                const barY = Math.min(yOpen, yClose);
                const barH = Math.max(Math.abs(yOpen - yClose), 1);

                const volH = (candle.volume / Math.max(...historyData.candles.map(c=>c.volume))) * 30;
                const volY = svgHeight - paddingBottom - volH;

                return (
                  <g key={idx}>
                    <rect x={x - w/2} y={volY} width={w} height={volH} fill={isBullish ? "rgba(0, 230, 118, 0.12)" : "rgba(255, 23, 68, 0.12)"} />
                    <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={isBullish ? "#00e676" : "#ff1744"} strokeWidth={1.5} />
                    <rect x={x - w/2} y={barY} width={w} height={barH} fill={isBullish ? "#00e676" : "#ff1744"} />
                  </g>
                );
              })}

              {/* SMA overlay */}
              {showSMA && <path d={generateLinePath(historyData.sma20)} fill="none" stroke="#2196f3" strokeWidth={1.5} />}

              {/* EMA overlay */}
              {showEMA && <path d={generateLinePath(historyData.ema20)} fill="none" stroke="#ff9800" strokeWidth={1.5} />}

              {/* Draw custom technical markings */}
              {drawings.map((draw) => {
                if (draw.type === "horizontal") {
                  const y = getY(draw.p1.price);
                  return (
                    <g key={draw.id}>
                      <line x1={0} y1={y} x2={chartWidth} y2={y} stroke="#ffea00" strokeWidth={1.5} strokeDasharray="3 2" />
                      <text x={6} y={y - 4} fontSize={8} fill="#ffea00" fontWeight="bold">Alert Level: ${draw.p1.price}</text>
                    </g>
                  );
                } else if (draw.type === "trend" && draw.p2) {
                  const x1 = getX(draw.p1.idx);
                  const y1 = getY(draw.p1.price);
                  const x2 = getX(draw.p2.idx);
                  const y2 = getY(draw.p2.price);
                  return (
                    <line key={draw.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#d500f9" strokeWidth={2} />
                  );
                }
                return null;
              })}

              {/* Click to draw preview */}
              {partialDraw && (
                <circle cx={getX(partialDraw.idx)} cy={getY(partialDraw.price)} r={4} fill="#d500f9" />
              )}

              {/* Synchronized Crosshair indicators */}
              {hoverIndex !== null && (
                <g>
                  <line x1={getX(hoverIndex)} y1={0} x2={getX(hoverIndex)} y2={svgHeight - paddingBottom} stroke="#4f46e5" strokeWidth={0.8} strokeDasharray="2 2" />
                  {hoverYPrice !== null && (
                    <g>
                      <line x1={0} y1={getY(hoverYPrice)} x2={chartWidth} y2={getY(hoverYPrice)} stroke="#4f46e5" strokeWidth={0.8} strokeDasharray="2 2" />
                      {/* Price box alert label */}
                      <rect x={chartWidth} y={getY(hoverYPrice) - 8} width={45} height={16} fill="#4f46e5" rx={2} />
                      <text x={chartWidth + 6} y={getY(hoverYPrice) + 4} fontSize={8} fill="#fff" fontWeight="bold">${hoverYPrice}</text>
                    </g>
                  )}
                  <circle cx={getX(hoverIndex)} cy={getY(activeCandle.close)} r={4} fill="var(--accent)" />
                </g>
              )}
            </svg>
          </div>

          {/* RSI Panel Viewport */}
          {showRSI && (
            <div style={styles.indicatorBox}>
              <div style={styles.chartLegend}>
                <span style={{ color: "#e040fb" }}><strong>RSI (14):</strong> {activeRsi ? activeRsi.toFixed(2) : "--"} ({techSignals.rsiSignal})</span>
              </div>
              <svg viewBox={`0 0 ${svgWidth} ${rsiHeight}`} style={styles.svgIndicator}>
                {/* 30-70 horizontal bounds shaded rectangle */}
                <rect x={0} y={getRsiY(70)} width={chartWidth} height={getRsiY(30) - getRsiY(70)} fill="rgba(224, 64, 251, 0.03)" />
                <line x1={0} y1={getRsiY(70)} x2={chartWidth} y2={getRsiY(70)} stroke="rgba(255,23,68,0.4)" strokeWidth={0.5} strokeDasharray="3 3" />
                <line x1={0} y1={getRsiY(30)} x2={chartWidth} y2={getRsiY(30)} stroke="rgba(0,230,118,0.4)" strokeWidth={0.5} strokeDasharray="3 3" />
                <text x={chartWidth + 6} y={getRsiY(70) + 3} fontSize={8} fill="#ff1744">70</text>
                <text x={chartWidth + 6} y={getRsiY(30) + 3} fontSize={8} fill="#00e676">30</text>

                {/* RSI path */}
                <path 
                  d={historyData.rsi14.map((val, idx) => {
                    if (val === null) return "";
                    return `${idx === 0 || historyData.rsi14[idx - 1] === null ? "M" : "L"} ${getX(idx)} ${getRsiY(val)}`;
                  }).join(" ")}
                  fill="none"
                  stroke="#e040fb"
                  strokeWidth={1.5}
                />

                {/* Sync crosshair */}
                {hoverIndex !== null && (
                  <line x1={getX(hoverIndex)} y1={0} x2={getX(hoverIndex)} y2={rsiHeight} stroke="#4f46e5" strokeWidth={0.8} strokeDasharray="2 2" />
                )}
              </svg>
            </div>
          )}

          {/* MACD Panel Viewport */}
          {showMACD && (
            <div style={styles.indicatorBox}>
              <div style={styles.chartLegend}>
                <span style={{ color: "#00e676" }}><strong>MACD:</strong> Line: {activeMacd ? activeMacd.toFixed(2) : "--"} | Signal: {historyData.macdSignal[hoverIndex ?? historyData.macdSignal.length - 1]?.toFixed(2) ?? "--"}</span>
              </div>
              <svg viewBox={`0 0 ${svgWidth} ${macdHeight}`} style={styles.svgIndicator}>
                <line x1={0} y1={getMacdY(0)} x2={chartWidth} y2={getMacdY(0)} stroke="#1e293b" strokeWidth={0.5} />

                {/* Histogram grid */}
                {historyData.macdHist.map((val, idx) => {
                  if (val === null) return null;
                  const x = getX(idx);
                  const w = (chartWidth / historyData.candles.length) * 0.6;
                  const zeroY = getMacdY(0);
                  const y = getMacdY(val);
                  
                  // Color histogram green if MACD is above signal and rising
                  const isBullish = val >= 0;
                  return (
                    <rect 
                      key={idx}
                      x={x - w/2}
                      y={val >= 0 ? y : zeroY}
                      width={w}
                      height={Math.max(Math.abs(y - zeroY), 1)}
                      fill={isBullish ? "rgba(0, 230, 118, 0.5)" : "rgba(255, 23, 68, 0.5)"}
                    />
                  );
                })}

                <path 
                  d={historyData.macd.map((val, idx) => {
                    if (val === null) return "";
                    return `${idx === 0 || historyData.macd[idx - 1] === null ? "M" : "L"} ${getX(idx)} ${getMacdY(val)}`;
                  }).join(" ")}
                  fill="none"
                  stroke="#2196f3"
                  strokeWidth={1.2}
                />

                <path 
                  d={historyData.macdSignal.map((val, idx) => {
                    if (val === null) return "";
                    return `${idx === 0 || historyData.macdSignal[idx - 1] === null ? "M" : "L"} ${getX(idx)} ${getMacdY(val)}`;
                  }).join(" ")}
                  fill="none"
                  stroke="#ff9800"
                  strokeWidth={1.2}
                />

                {/* Sync crosshair */}
                {hoverIndex !== null && (
                  <line x1={getX(hoverIndex)} y1={0} x2={getX(hoverIndex)} y2={macdHeight} stroke="#4f46e5" strokeWidth={0.8} strokeDasharray="2 2" />
                )}
              </svg>
            </div>
          )}
        </div>

        {/* Sidebar Analytics Diagnostics details */}
        <div style={styles.sidebar}>
          <div style={styles.card}>
            <h4 style={styles.cardTitle}>Gauge Rating Dashboard</h4>
            <div style={styles.signalValue}>
              <span style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase" }}>Aggregate Signals</span>
              <div style={{ 
                fontSize: 16, 
                fontWeight: "800", 
                color: techSignals.overall.includes("BUY") ? "#00e676" : "#ff1744",
                marginTop: 2
              }}>
                {techSignals.overall}
              </div>
            </div>

            {/* Simulated gauge needle */}
            <div style={styles.gaugeContainer}>
              <div style={styles.gaugeTrack} />
              <div 
                style={{ 
                  ...styles.gaugeNeedle, 
                  transform: `rotate(${
                    techSignals.overall === "STRONG BUY" ? 45 : (techSignals.overall === "BUY" ? 20 : (techSignals.overall === "STRONG SELL" ? -45 : -20))
                  }deg)`
                }} 
              />
            </div>

            <div style={styles.metricRow}>
              <span>RSI Indicator</span>
              <span style={{ color: techSignals.rsiSignal.includes("BUY") ? "#00e676" : (techSignals.rsiSignal.includes("SELL") ? "#ff1744" : "#94a3b8") }}>
                {techSignals.rsiSignal.split(" ")[0]}
              </span>
            </div>

            <div style={styles.metricRow}>
              <span>MACD Crossings</span>
              <span style={{ color: techSignals.macdSignal.includes("BUY") ? "#00e676" : "#ff1744" }}>
                {techSignals.macdSignal.split(" ")[0]}
              </span>
            </div>
          </div>

          <div style={styles.card}>
            <h4 style={styles.cardTitle}>Trading Statistics</h4>
            <div style={styles.metricRow}>
              <span>52W High</span>
              <span style={{ color: "#eceff1" }}>${(currentCandle.close * 1.15).toFixed(2)}</span>
            </div>
            <div style={styles.metricRow}>
              <span>52W Low</span>
              <span style={{ color: "#eceff1" }}>${(currentCandle.close * 0.78).toFixed(2)}</span>
            </div>
            <div style={styles.metricRow}>
              <span>Earnings Yield</span>
              <span style={{ color: "#eceff1" }}>3.45%</span>
            </div>
          </div>

          <div style={styles.infoBox}>
            <span>Use drawing tools to plot trendlines directly on the SVG candlestick graph. Settings auto-refresh on range switches.</span>
          </div>
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
    backgroundColor: "#090d16", // Constant dark theme background
    color: "#eceff1",
    overflow: "hidden",
    fontFamily: "var(--font-sans)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    padding: "12px 16px",
    backgroundColor: "#111827",
    borderBottom: "1px solid #1f2937",
    zIndex: 10,
  },
  headerTitleGroup: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
  },
  tickerSelect: {
    padding: "6px 12px",
    fontSize: "14px",
    fontWeight: "bold",
    borderRadius: "var(--radius-sm)",
    border: "1px solid #374151",
    backgroundColor: "#1f2937",
    color: "#fff",
    outline: "none",
    cursor: "pointer",
  },
  priceContainer: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
  },
  priceLabel: {
    fontSize: "20px",
    fontWeight: "800",
    color: "#fff",
  },
  changeLabel: {
    fontSize: "13px",
    fontWeight: "600",
  },
  timeGroup: {
    display: "flex",
    backgroundColor: "#1f2937",
    borderRadius: "var(--radius-md)",
    padding: "2px",
    border: "1px solid #374151",
  },
  timeBtn: {
    padding: "4px 10px",
    fontSize: "11px",
    fontWeight: "600",
    border: "none",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "transparent",
    color: "#9ca3af",
    cursor: "pointer",
  },
  timeBtnActive: {
    backgroundColor: "#111827",
    color: "var(--accent)",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "12px",
    padding: "8px 16px",
    backgroundColor: "#111827",
    borderBottom: "1px solid #1f2937",
    fontSize: "11.5px",
  },
  toolbarTitle: {
    fontWeight: "bold",
    color: "#9ca3af",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    cursor: "pointer",
  },
  checkbox: {
    cursor: "pointer",
  },
  divider: {
    width: "1px",
    height: "14px",
    backgroundColor: "#374151",
  },
  viewportLayout: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  drawingToolbar: {
    width: "48px",
    borderRight: "1px solid #1f2937",
    backgroundColor: "#111827",
    display: "flex",
    flexDirection: "column",
    padding: "8px 4px",
    gap: "6px",
  },
  drawBtn: {
    padding: "6px 2px",
    fontSize: "9px",
    fontWeight: "600",
    textTransform: "uppercase",
    borderRadius: "4px",
    border: "1px solid #374151",
    backgroundColor: "#1f2937",
    color: "#9ca3af",
    cursor: "pointer",
  },
  drawBtnActive: {
    backgroundColor: "var(--accent)",
    borderColor: "var(--accent)",
    color: "#fff",
  },
  chartCol: {
    flex: 1,
    overflowY: "auto",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  chartBox: {
    backgroundColor: "#111827",
    borderRadius: "var(--radius-lg)",
    border: "1px solid #1f2937",
    padding: "16px",
  },
  chartLegend: {
    fontSize: "9px",
    fontFamily: "var(--font-mono)",
    color: "#9ca3af",
    marginBottom: "10px",
  },
  svg: {
    width: "100%",
    height: "auto",
    overflow: "visible",
  },
  indicatorBox: {
    backgroundColor: "#111827",
    borderRadius: "var(--radius-lg)",
    border: "1px solid #1f2937",
    padding: "12px 16px",
  },
  svgIndicator: {
    width: "100%",
    height: "auto",
    overflow: "visible",
  },
  sidebar: {
    width: "250px",
    borderLeft: "1px solid #1f2937",
    backgroundColor: "#111827",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    overflowY: "auto",
  },
  card: {
    border: "1px solid #1f2937",
    borderRadius: "var(--radius-md)",
    backgroundColor: "#090d16",
    padding: "12px",
  },
  cardTitle: {
    fontSize: "10px",
    fontWeight: "bold",
    textTransform: "uppercase",
    color: "#64748b",
    letterSpacing: "0.5px",
    marginBottom: "10px",
    borderBottom: "1px dashed #1f2937",
    paddingBottom: "4px",
  },
  signalValue: {
    backgroundColor: "#111827",
    borderRadius: "var(--radius-sm)",
    padding: "8px",
    marginBottom: "10px",
    border: "1px solid #1f2937",
  },
  gaugeContainer: {
    height: "12px",
    backgroundColor: "#1f2937",
    borderRadius: "6px",
    position: "relative",
    margin: "12px 0 16px 0",
    overflow: "visible",
  },
  gaugeTrack: {
    position: "absolute",
    left: "50%",
    top: 0,
    width: "2px",
    height: "100%",
    backgroundColor: "#e2e8f0",
  },
  gaugeNeedle: {
    position: "absolute",
    left: "50%",
    bottom: "50%",
    width: "2px",
    height: "14px",
    backgroundColor: "var(--accent)",
    transformOrigin: "bottom center",
    transition: "transform 0.3s ease",
  },
  metricRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "11.5px",
    color: "#9ca3af",
    padding: "4px 0",
  },
  infoBox: {
    padding: "12px",
    backgroundColor: "rgba(99, 102, 241, 0.05)",
    border: "1px dashed #1f2937",
    borderRadius: "var(--radius-md)",
    fontSize: "10px",
    lineHeight: "1.4",
    color: "#64748b",
  }
};
