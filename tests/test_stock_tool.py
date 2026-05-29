import json
import pytest
from sidecar.agent.tools import (
    _get_stock_data,
    _calc_sma,
    _calc_ema,
    _calc_rsi,
    _calc_macd
)

def test_technical_calculations():
    # Simple input series
    prices = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0]
    
    # Test SMA
    sma3 = _calc_sma(prices, 3)
    assert len(sma3) == 6
    assert sma3[0] is None
    assert sma3[1] is None
    assert sma3[2] == pytest.approx(11.0) # (10+11+12)/3
    assert sma3[5] == pytest.approx(14.0) # (13+14+15)/3

    # Test EMA
    ema3 = _calc_ema(prices, 3)
    assert len(ema3) == 6
    assert ema3[0] is None
    assert ema3[1] is None
    assert ema3[2] == pytest.approx(11.0) # Initial EMA is SMA
    # K = 2 / (3 + 1) = 0.5
    # EMA_3 = 13.0 * 0.5 + 11.0 * 0.5 = 12.0
    # EMA_4 = 14.0 * 0.5 + 12.0 * 0.5 = 13.0
    assert ema3[3] == pytest.approx(12.0)
    assert ema3[4] == pytest.approx(13.0)

def test_rsi_calculation():
    # Warmup list of prices
    prices = [100.0] * 20
    rsi = _calc_rsi(prices, 14)
    assert len(rsi) == 20
    # Since there are no price movements, RSI should be neutral/0 or bounded
    assert rsi[14] is not None

def test_macd_calculation():
    prices = [float(x) for x in range(30)]
    macd, signal, hist = _calc_macd(prices)
    assert len(macd) == 30
    assert len(signal) == 30
    assert len(hist) == 30

def test_get_stock_data():
    # Fetch real/mock stock data for AAPL
    try:
        res_json = _get_stock_data("AAPL", "30d")
        data = json.loads(res_json)
        
        assert data["ticker"] == "AAPL"
        assert "meta" in data
        assert "candles" in data
        assert len(data["candles"]) > 0
        
        candle = data["candles"][-1]
        assert "date" in candle
        assert "open" in candle
        assert "high" in candle
        assert "low" in candle
        assert "close" in candle
        assert "volume" in candle
        assert "sma_20" in candle
        assert "ema_20" in candle
        assert "rsi_14" in candle
        assert "macd" in candle
        
    except Exception as e:
        # If offline or rate-limited by Yahoo, fail the test
        pytest.fail(f"_get_stock_data raised exception: {e}")
