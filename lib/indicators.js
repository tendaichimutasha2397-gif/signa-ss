// Plain technical-indicator math over a closing-price series. Nothing here
// is a "signal" or a recommendation — it's descriptive statistics about
// price history, labeled and returned as such. The caller/UI is responsible
// for presenting these as reference indicators, never as buy/sell advice.

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (prev == null) {
      // seed with SMA of the first `period` points once we have enough
      if (i >= period - 1) {
        const slice = values.slice(i - period + 1, i + 1);
        prev = slice.reduce((a, b) => a + b, 0) / period;
        out[i] = prev;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Classic Wilder RSI. Returns an array aligned with `values`; entries before
// there's enough history are null.
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
  const signalLine = ema(macdLine.map((v) => (v == null ? 0 : v)), signalPeriod);
  // Null out signal wherever the underlying macd wasn't ready yet.
  for (let i = 0; i < macdLine.length; i++) if (macdLine[i] == null) signalLine[i] = null;
  const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null ? v - signalLine[i] : null));
  return { macdLine, signalLine, hist };
}

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

function rsiZone(value) {
  if (value == null) return 'unknown';
  if (value >= 70) return 'overbought';
  if (value <= 30) return 'oversold';
  return 'neutral';
}

/**
 * Computes the full indicator set for one asset's closing-price history.
 * `closes` should be oldest-first. `volumes` (optional, same order) enables
 * the volume-spike flag. Returns a snapshot of the *latest* values plus
 * enough of the trailing series for a small sparkline, and simple crossover
 * flags (SMA20/SMA50, RSI zone) the caller can diff against the previous
 * snapshot to detect a fresh crossover for alerting.
 */
function computeIndicators(closes, volumes = []) {
  if (!closes || closes.length < 2) return null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsiSeries = rsi(closes, 14);
  const macdRes = macd(closes);

  const latestClose = last(closes);
  const latestSma20 = last(sma20);
  const latestSma50 = last(sma50);
  const latestRsi = last(rsiSeries);
  const latestHist = last(macdRes.hist);

  let trend = 'neutral';
  if (latestSma20 != null && latestSma50 != null) {
    trend = latestSma20 > latestSma50 ? 'bullish' : latestSma20 < latestSma50 ? 'bearish' : 'neutral';
  }

  let volumeSpike = null;
  if (volumes && volumes.length >= 5) {
    const recent = volumes[volumes.length - 1];
    const priorWindow = volumes.slice(-21, -1);
    if (priorWindow.length) {
      const avg = priorWindow.reduce((a, b) => a + b, 0) / priorWindow.length;
      volumeSpike = { current: recent, avg, ratio: avg ? recent / avg : null, isSpike: avg ? recent > avg * 2 : false };
    }
  }

  return {
    close: latestClose,
    sma20: latestSma20,
    sma50: latestSma50,
    smaTrend: trend,
    rsi: latestRsi != null ? Math.round(latestRsi * 10) / 10 : null,
    rsiZone: rsiZone(latestRsi),
    macdHistogram: latestHist != null ? Math.round(latestHist * 10000) / 10000 : null,
    volumeSpike,
    sparkline: closes.slice(-30),
  };
}

module.exports = { sma, ema, rsi, macd, computeIndicators, rsiZone };
