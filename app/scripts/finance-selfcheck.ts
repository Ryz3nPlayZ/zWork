// Self-check for the Finance tab's pure logic. Run: node --experimental-strip-types scripts/finance-selfcheck.ts
import assert from "node:assert/strict";
import { squarify } from "../src/components/finance/treemap.ts";
import { applyScreen, EMPTY_SCREEN, parseCommand, parseScreen } from "../src/components/finance/parse.ts";
import { csvRows, parseBrokerCsv } from "../src/components/finance/csv.ts";

// Treemap: areas proportional to value, inside the box, nothing lost.
const tiles = squarify([6, 6, 4, 3, 2, 2, 1], (v) => v, { x: 0, y: 0, w: 600, h: 400 });
assert.equal(tiles.length, 7);
for (const t of tiles) {
  assert.ok(Math.abs(t.w * t.h - (t.item / 24) * 240000) < 1e-6, "area matches value");
  assert.ok(t.x >= -1e-9 && t.y >= -1e-9 && t.x + t.w <= 600 + 1e-6 && t.y + t.h <= 400 + 1e-6, "inside box");
}
assert.deepEqual(squarify([0, -1], (v) => v, { x: 0, y: 0, w: 10, h: 10 }), []);

// Screens from words.
const tech = parseScreen("profitable tech under 25 pe")!;
assert.equal(tech.sector, "Information Technology");
assert.equal(tech.peMax, 25);
assert.ok(tech.marginMin! > 0);
assert.equal(parseScreen("hello there"), null);
const rows = [
  { symbol: "A", sector: "Information Technology", marketCap: 3e12, pe: 30, dividendYield: 0.5, revenueGrowth: 10, netMargin: 25, changeYtd: 5 },
  { symbol: "B", sector: "Information Technology", marketCap: 1e11, pe: 18, dividendYield: null, revenueGrowth: 4, netMargin: 12, changeYtd: -2 },
  { symbol: "C", sector: "Energy", marketCap: 5e11, pe: null, dividendYield: 3.5, revenueGrowth: -1, netMargin: 8, changeYtd: 1 },
];
assert.deepEqual(applyScreen(rows, tech).map((r) => r.symbol), ["B"]);
assert.deepEqual(applyScreen(rows, { ...EMPTY_SCREEN, yieldMin: 3 }).map((r) => r.symbol), ["C"]);
assert.deepEqual(applyScreen(rows, { ...EMPTY_SCREEN, sort: "pe", desc: false }).map((r) => r.symbol), ["B", "A", "C"], "nulls sort last");

// Command bar.
assert.deepEqual(parseCommand("aapl vs msft"), { kind: "compare", symbols: ["AAPL", "MSFT"] });
assert.deepEqual(parseCommand("nvda"), { kind: "symbol", symbol: "NVDA" });
assert.equal(parseCommand("why is nvda down today?"), null);
assert.equal(parseCommand("earnings this week")?.kind, "view");

// CSV.
assert.deepEqual(csvRows('a,"b,c","d ""q"""\r\n1,2,3'), [["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
const fidelity = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Average Cost Basis
X1,Individual,SPAXX**,HELD IN MONEY MARKET,,,$1200.00,,
X1,Individual,AAPL,APPLE INC,10,$190.00,$1900.00,$1500.00,$150.00
Z2,Roth IRA,AAPL,APPLE INC,10,$190.00,$1900.00,$1700.00,$170.00
Z2,Roth IRA,VTI,VANGUARD TOTAL,5.5,$250,$1375,--,--
,,Pending Activity,,,,$-50.00,,
"The data and information in this spreadsheet is provided to you solely for your use"`;
const f = parseBrokerCsv(fidelity);
assert.ok("holdings" in f && f.kind === "positions");
assert.deepEqual(f.holdings, [{ symbol: "AAPL", shares: 20, cost: 160 }, { symbol: "VTI", shares: 5.5, cost: null }]);
const schwab = `"Positions for account Individual ...123 as of 09:30 AM ET, 2026/11/20"

"Symbol","Description","Qty (Quantity)","Price","Mkt Val (Market Value)","Cost Basis","Gain/Loss %"
"MSFT","MICROSOFT CORP","4","$420.00","$1,680.00","$1,200.00","40%"
"BRK/B","BERKSHIRE HATHAWAY","2","$450.00","$900.00","$800.00","12.5%"
"Cash & Cash Investments","--","--","--","$300.00","--","--"
"Account Total","--","--","--","$2,880.00","$2,000.00","--"`;
const s = parseBrokerCsv(schwab);
assert.ok("holdings" in s);
assert.deepEqual(s.holdings, [{ symbol: "MSFT", shares: 4, cost: 300 }, { symbol: "BRK.B", shares: 2, cost: 400 }]);
const webull = `Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time
Tesla,TSLA,Sell,Filled,5,5,,260.00,DAY,03/02/2026 10:00:00 EST,03/02/2026 10:00:01 EST
Tesla,TSLA,Buy,Filled,10,10,200.00,200.00,DAY,01/05/2026 10:00:00 EST,01/05/2026 10:00:01 EST
Apple,AAPL,Buy,Cancelled,0,3,180,,DAY,01/06/2026 10:00:00 EST,`;
const w = parseBrokerCsv(webull);
assert.ok("holdings" in w && w.kind === "orders");
assert.deepEqual(w.holdings, [{ symbol: "TSLA", shares: 5, cost: 200 }], "sell replayed after the earlier buy");
const robinhood = `"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"
"2/1/2026","2/1/2026","2/3/2026","AMD","Advanced Micro","Buy","4","$100.00","($400.00)"
"1/15/2026","1/15/2026","1/15/2026","AMD","Cash Div","CDIV","","","$1.00"
"1/2/2026","1/2/2026","1/4/2026","AMD","Advanced Micro","Buy","6","$90.00","($540.00)"
"","","","","","","","","The data provided is for informational purposes only."`;
const r = parseBrokerCsv(robinhood);
assert.ok("holdings" in r);
assert.deepEqual(r.holdings, [{ symbol: "AMD", shares: 10, cost: 94 }]);
assert.ok("error" in parseBrokerCsv("a,b\n1,2"));

console.log("finance self-check: ok");
