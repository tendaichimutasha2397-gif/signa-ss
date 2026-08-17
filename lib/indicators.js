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

// Bollinger Bands: SMA20 basis +/- 2 standard deviations. Returns arrays
// aligned with `values`. A "squeeze" (bands unusually narrow vs their own
// recent history) is a descriptive volatility observation, not a signal.
function bollinger(values, period = 20, mult = 2) {
  const basis = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  const width = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (basis[i] == null) continue;
    const slice = values.slice(i - period + 1, i + 1);
    const mean = basis[i];
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
    width[i] = mean ? (upper[i] - lower[i]) / mean : null;
  }
  return { basis, upper, lower, width };
}

// Average True Range (Wilder-smoothed). Needs highs/lows/closes — a pure
// volatility measure (how much the asset typically moves), not directional.
function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prevAtr = sum / period;
  out[period] = prevAtr;
  for (let i = period + 1; i < n; i++) {
    prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

// Stochastic Oscillator (%K, %D). Needs highs/lows/closes. Like RSI, this is
// a bounded momentum reading (0-100) about where price sits within its
// recent range — not a prediction of what happens next.
function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const n = closes.length;
  const k = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    const hSlice = highs.slice(i - kPeriod + 1, i + 1);
    const lSlice = lows.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...hSlice);
    const ll = Math.min(...lSlice);
    k[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const d = sma(k.map((v) => (v == null ? 0 : v)), dPeriod);
  for (let i = 0; i < n; i++) if (k[i] == null) d[i] = null;
  return { k, d };
}

/**
 * Computes the full indicator set for one asset's closing-price history.
 * `closes` should be oldest-first. `volumes` (optional, same order) enables
 * the volume-spike flag. `highs`/`lows` (optional, same order) enable ATR
 * and Stochastic — when absent those fields come back null rather than
 * approximated, since faking a high/low from close-only data would be
 * misleading. Returns a snapshot of the *latest* values plus enough of the
 * trailing series for a small sparkline, and simple crossover flags
 * (SMA20/SMA50, RSI zone) the caller can diff against the previous snapshot
 * to detect a fresh crossover for alerting.
 */
function computeIndicators(closes, volumes = [], highs = null, lows = null) {
  if (!closes || closes.length < 2) return null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsiSeries = rsi(closes, 14);
  const macdRes = macd(closes);
  const boll = bollinger(closes, 20, 2);

  const latestClose = last(closes);
  const latestSma20 = last(sma20);
  const latestSma50 = last(sma50);
  const latestRsi = last(rsiSeries);
  const latestHist = last(macdRes.hist);
  const latestBollUpper = last(boll.upper);
  const latestBollLower = last(boll.lower);
  const latestBollWidth = last(boll.width);

  let bollPosition = null; // where price sits relative to the bands, descriptive only
  if (latestBollUpper != null && latestBollLower != null) {
    if (latestClose >= latestBollUpper) bollPosition = 'at_or_above_upper';
    else if (latestClose <= latestBollLower) bollPosition = 'at_or_below_lower';
    else bollPosition = 'inside_bands';
  }

  let latestAtr = null;
  let latestStochK = null;
  let latestStochD = null;
  let stochZone = 'unknown';
  const hasOhlc = Array.isArray(highs) && Array.isArray(lows) && highs.length === closes.length && lows.length === closes.length;
  if (hasOhlc) {
    const atrSeries = atr(highs, lows, closes, 14);
    latestAtr = last(atrSeries);
    const stoch = stochastic(highs, lows, closes, 14, 3);
    latestStochK = last(stoch.k);
    latestStochD = last(stoch.d);
    if (latestStochK != null) {
      stochZone = latestStochK >= 80 ? 'overbought' : latestStochK <= 20 ? 'oversold' : 'neutral';
    }
  }

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

  const confluence = computeConfluence({ trend, latestRsi, latestHist, volumeSpike, bollPosition, latestStochK, stochZone });

  return {
    close: latestClose,
    sma20: latestSma20,
    sma50: latestSma50,
    smaTrend: trend,
    rsi: latestRsi != null ? Math.round(latestRsi * 10) / 10 : null,
    rsiZone: rsiZone(latestRsi),
    macdHistogram: latestHist != null ? Math.round(latestHist * 10000) / 10000 : null,
    bollinger: latestBollUpper != null ? {
      upper: Math.round(latestBollUpper * 100) / 100,
      lower: Math.round(latestBollLower * 100) / 100,
      width: latestBollWidth != null ? Math.round(latestBollWidth * 10000) / 10000 : null,
      position: bollPosition,
    } : null,
    atr14: latestAtr != null ? Math.round(latestAtr * 100) / 100 : null,
    stochastic: latestStochK != null ? {
      k: Math.round(latestStochK * 10) / 10,
      d: latestStochD != null ? Math.round(latestStochD * 10) / 10 : null,
      zone: stochZone,
    } : null,
    volumeSpike,
    confluence,
    sparkline: closes.slice(-30),
  };
}

/**
 * Tallies which way each individual indicator is currently leaning —
 * nothing more. This is a transparent count ("3 up / 1 down / 1 flat"),
 * not a synthesized verdict, and it deliberately has no "action" field.
 * The point is to let you see at a glance whether the indicators agree or
 * disagree with each other, and inspect exactly which ones say what,
 * rather than being handed a single conclusion.
 */
function computeConfluence({ trend, latestRsi, latestHist, volumeSpike, bollPosition, latestStochK, stochZone }) {
  const readings = [];

  readings.push({
    indicator: 'sma_trend',
    detail: trend === 'bullish' ? 'SMA20 above SMA50' : trend === 'bearish' ? 'SMA20 below SMA50' : 'SMA20/50 flat',
    lean: trend === 'bullish' ? 'up' : trend === 'bearish' ? 'down' : 'flat',
  });

  if (latestRsi != null) {
    const zone = rsiZone(latestRsi);
    readings.push({
      indicator: 'rsi',
      detail: `RSI ${Math.round(latestRsi * 10) / 10} (${zone})`,
      // Note: RSI "lean" here just describes which side of neutral it's on,
      // not a prediction — overbought/oversold can persist a long time.
      lean: zone === 'overbought' ? 'up' : zone === 'oversold' ? 'down' : 'flat',
    });
  } else {
    readings.push({ indicator: 'rsi', detail: 'not enough history', lean: 'flat' });
  }

  if (latestHist != null) {
    readings.push({
      indicator: 'macd_histogram',
      detail: `MACD histogram ${latestHist > 0 ? 'positive' : latestHist < 0 ? 'negative' : 'flat'} (${Math.round(latestHist * 10000) / 10000})`,
      lean: latestHist > 0 ? 'up' : latestHist < 0 ? 'down' : 'flat',
    });
  } else {
    readings.push({ indicator: 'macd_histogram', detail: 'not enough history', lean: 'flat' });
  }

  if (bollPosition) {
    readings.push({
      indicator: 'bollinger',
      detail: bollPosition === 'at_or_above_upper' ? 'price at/above upper band' : bollPosition === 'at_or_below_lower' ? 'price at/below lower band' : 'price inside the bands',
      // Descriptive only: touching a band means "stretched relative to recent volatility," not "about to reverse."
      lean: bollPosition === 'at_or_above_upper' ? 'up' : bollPosition === 'at_or_below_lower' ? 'down' : 'flat',
    });
  }

  if (latestStochK != null) {
    readings.push({
      indicator: 'stochastic',
      detail: `Stoch %K ${Math.round(latestStochK * 10) / 10} (${stochZone})`,
      lean: stochZone === 'overbought' ? 'up' : stochZone === 'oversold' ? 'down' : 'flat',
    });
  }

  if (volumeSpike) {
    readings.push({
      indicator: 'volume',
      detail: volumeSpike.isSpike ? `volume ${volumeSpike.ratio.toFixed(1)}x average (elevated interest, direction not implied)` : 'volume near average',
      lean: 'flat', // volume alone never gets counted up/down — it says "more activity," not which direction
    });
  }

  const up = readings.filter((r) => r.lean === 'up').length;
  const down = readings.filter((r) => r.lean === 'down').length;
  const flat = readings.length - up - down;

  return { up, down, flat, total: readings.length, readings };
}

module.exports = { sma, ema, rsi, macd, bollinger, atr, stochastic, computeIndicators, computeConfluence, rsiZone };
