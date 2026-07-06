use serde_json::{json, Value};

/// Fetch stock data from Yahoo Finance and compute technical indicators.
pub async fn execute_get_stock_data(params: &Value) -> Result<String, String> {
    let ticker = params.get("ticker").and_then(|v| v.as_str()).unwrap_or("AAPL");
    let range = params.get("range").and_then(|v| v.as_str()).unwrap_or("3mo");

    let url = format!(
        "https://query1.finance.yahoo.com/v8/chart/{}?range={}&interval=1d",
        ticker, range
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 zWork/1.0")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client.get(&url).send().await
        .map_err(|e| format!("Failed to fetch stock data: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Yahoo Finance returned status {}", resp.status()));
    }

    let body: Value = resp.json().await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    // Extract close prices
    let timestamps = body.get("chart").and_then(|c| c.get("result"))
        .and_then(|r| r.get(0)).and_then(|r| r.get("timestamp"))
        .and_then(|t| t.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect::<Vec<_>>())
        .unwrap_or_default();

    let closes = body.get("chart").and_then(|c| c.get("result"))
        .and_then(|r| r.get(0)).and_then(|r| r.get("indicators"))
        .and_then(|i| i.get("quote")).and_then(|q| q.get(0))
        .and_then(|q| q.get("close"))
        .and_then(|c| c.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect::<Vec<f64>>())
        .unwrap_or_default();

    if closes.is_empty() {
        return Err("No price data available for this ticker/range".to_string());
    }

    let current = closes.last().unwrap_or(&0.0);
    let first = closes.first().unwrap_or(&0.0);
    let change_pct = if *first != 0.0 { ((current - first) / first) * 100.0 } else { 0.0 };

    let mut result = json!({
        "ticker": ticker,
        "range": range,
        "current_price": current,
        "change_pct": format!("{:.2}%", change_pct),
        "data_points": closes.len(),
        "high": closes.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b)),
        "low": closes.iter().fold(f64::INFINITY, |a, &b| a.min(b)),
    });

    // Compute indicators
    if closes.len() >= 20 {
        if let Some(sma) = compute_sma(&closes, 20) {
            result["sma_20"] = json!(sma);
        }
        if let Some(ema) = compute_ema(&closes, 20) {
            result["ema_20"] = json!(ema);
        }
    }
    if closes.len() >= 14 {
        if let Some(rsi) = compute_rsi(&closes, 14) {
            result["rsi_14"] = json!(rsi);
        }
    }
    if closes.len() >= 26 {
        if let Some((macd, signal, histogram)) = compute_macd(&closes) {
            result["macd"] = json!({
                "macd_line": macd,
                "signal_line": signal,
                "histogram": histogram,
            });
        }
    }

    // Recent OHLCV summary (last 5 days)
    let recent_count = closes.len().min(5);
    let recent_start = closes.len() - recent_count;
    let mut recent = Vec::new();
    for i in recent_start..closes.len() {
        let ts = timestamps.get(i).copied().unwrap_or(0);
        let date = if ts > 0 {
            chrono::DateTime::from_timestamp(ts, 0)
                .map(|dt| dt.format("%Y-%m-%d").to_string())
                .unwrap_or_default()
        } else { String::new() };
        recent.push(json!({
            "date": date,
            "close": closes[i],
        }));
    }
    result["recent"] = json!(recent);

    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

fn compute_sma(data: &[f64], period: usize) -> Option<f64> {
    if data.len() < period { return None; }
    let slice = &data[data.len() - period..];
    Some(slice.iter().sum::<f64>() / period as f64)
}

fn compute_ema(data: &[f64], period: usize) -> Option<f64> {
    if data.len() < period { return None; }
    let multiplier = 2.0 / (period as f64 + 1.0);
    let mut ema = data[..period].iter().sum::<f64>() / period as f64;
    for price in &data[period..] {
        ema = (price - ema) * multiplier + ema;
    }
    Some(ema)
}

fn compute_rsi(data: &[f64], period: usize) -> Option<f64> {
    if data.len() < period + 1 { return None; }
    let mut gains = 0.0;
    let mut losses = 0.0;
    for i in (data.len() - period)..data.len() {
        let change = data[i] - data[i - 1];
        if change > 0.0 { gains += change; } else { losses += change.abs(); }
    }
    let avg_gain = gains / period as f64;
    let avg_loss = losses / period as f64;
    if avg_loss == 0.0 { return Some(100.0); }
    let rs = avg_gain / avg_loss;
    Some(100.0 - (100.0 / (1.0 + rs)))
}

fn compute_macd(data: &[f64]) -> Option<(f64, f64, f64)> {
    let ema12 = compute_ema(data, 12)?;
    let ema26 = compute_ema(data, 26)?;
    let macd_line = ema12 - ema26;
    // Simple signal approximation using last 9 EMA differences
    if data.len() < 35 { return None; }
    let mut macd_values = Vec::new();
    let m12 = 2.0 / 13.0;
    let m26 = 2.0 / 27.0;
    let mut e12 = data[..12].iter().sum::<f64>() / 12.0;
    let mut e26 = data[..26].iter().sum::<f64>() / 26.0;
    for price in &data[12..] {
        e12 = (price - e12) * m12 + e12;
    }
    for price in &data[26..] {
        e26 = (price - e26) * m26 + e26;
        macd_values.push(e12 - e26);
    }
    let signal = if macd_values.len() >= 9 {
        let m9 = 2.0 / 10.0;
        let mut sig = macd_values[..9].iter().sum::<f64>() / 9.0;
        for v in &macd_values[9..] { sig = (v - sig) * m9 + sig; }
        sig
    } else {
        macd_values.last().copied().unwrap_or(macd_line)
    };
    Some((macd_line, signal, macd_line - signal))
}
