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

// On-Balance Volume: a running total that adds the day's volume when price
// closed up and subtracts it when price closed down. Descriptive only — the
// *level* of OBV means nothing on its own; what's tracked below is its
// short-term slope (rising/falling), same spirit as everything else here.
function obv(closes, volumes) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (!volumes || volumes.length !== n) return out;
  let running = 0;
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1]) running += volumes[i];
    else if (closes[i] < closes[i - 1]) running -= volumes[i];
    out[i] = running;
  }
  return out;
}

// Rolling (anchored-to-window) VWAP — volume-weighted average price over a
// trailing window, using typical price ((H+L+C)/3) when highs/lows are
// available, close-only otherwise. True intraday VWAP resets every session;
// on daily bars this is a "N-day volume-weighted average," a fair reference
// level for where volume has actually transacted, not a signal.
function rollingVwap(closes, volumes, highs, lows, period = 20) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (!volumes || volumes.length !== n) return out;
  const hasHL = Array.isArray(highs) && Array.isArray(lows) && highs.length === n && lows.length === n;
  const typical = closes.map((c, i) => (hasHL && highs[i] != null && lows[i] != null ? (highs[i] + lows[i] + c) / 3 : c));
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    let pvSum = 0;
    let vSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      pvSum += typical[j] * (volumes[j] || 0);
      vSum += volumes[j] || 0;
    }
    out[i] = vSum ? pvSum / vSum : null;
  }
  return out;
}

// Wilder's ADX / +DI / -DI: ADX measures trend *strength* (how strongly
// price is trending, regardless of direction) — a genuinely different axis
// from SMA trend direction. +DI/-DI show which direction currently
// dominates. Conventionally: ADX < 20 = weak/no trend (range-bound), 20-25
// = developing, > 25 = trending, > 40 = strong trend. Purely descriptive —
// a high ADX means "this move has been persistent," not "it will continue."
function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const outAdx = new Array(n).fill(null);
  const outPlusDI = new Array(n).fill(null);
  const outMinusDI = new Array(n).fill(null);
  if (n < period * 2 + 1) return { adx: outAdx, plusDI: outPlusDI, minusDI: outMinusDI };

  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }

  let smTr = 0, smPlusDM = 0, smMinusDM = 0;
  for (let i = 1; i <= period; i++) { smTr += tr[i]; smPlusDM += plusDM[i]; smMinusDM += minusDM[i]; }

  const dxSeries = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      smTr = smTr - smTr / period + tr[i];
      smPlusDM = smPlusDM - smPlusDM / period + plusDM[i];
      smMinusDM = smMinusDM - smMinusDM / period + minusDM[i];
    }
    const pDI = smTr ? (smPlusDM / smTr) * 100 : 0;
    const mDI = smTr ? (smMinusDM / smTr) * 100 : 0;
    outPlusDI[i] = pDI;
    outMinusDI[i] = mDI;
    const dx = pDI + mDI ? (Math.abs(pDI - mDI) / (pDI + mDI)) * 100 : 0;
    dxSeries[i] = dx;
  }

  // ADX is Wilder-smoothed DX, seeded once enough DX values exist.
  let adxPrev = null;
  for (let i = period; i < n; i++) {
    if (dxSeries[i] == null) continue;
    if (adxPrev == null) {
      const window = dxSeries.slice(i - period + 1, i + 1).filter((v) => v != null);
      if (window.length < period) continue;
      adxPrev = window.reduce((a, b) => a + b, 0) / period;
      outAdx[i] = adxPrev;
    } else {
      adxPrev = (adxPrev * (period - 1) + dxSeries[i]) / period;
      outAdx[i] = adxPrev;
    }
  }
  return { adx: outAdx, plusDI: outPlusDI, minusDI: outMinusDI };
}

// Commodity Channel Index: how far the typical price sits from its own
// moving average, in units of mean deviation. Conventionally |CCI| > 100
// is called "outside the normal range" — descriptive of how stretched
// price is versus its own recent average, not a reversal prediction.
function cci(highs, lows, closes, period = 20) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  const hasHL = Array.isArray(highs) && Array.isArray(lows) && highs.length === n && lows.length === n;
  const typical = closes.map((c, i) => (hasHL ? (highs[i] + lows[i] + c) / 3 : c));
  for (let i = period - 1; i < n; i++) {
    const slice = typical.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const meanDev = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    out[i] = meanDev ? (typical[i] - mean) / (0.015 * meanDev) : 0;
  }
  return out;
}

// Williams %R: like Stochastic %K but inverted-scale (0 to -100). Same
// underlying idea — where does the close sit within its recent high/low
// range. Kept alongside Stochastic since some traders prefer its scaling,
// not because it says anything Stochastic doesn't.
function williamsR(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1, i + 1));
    out[i] = hh === ll ? -50 : ((hh - closes[i]) / (hh - ll)) * -100;
  }
  return out;
}

// Ichimoku Cloud (Kijun/Tenkan/Senkou spans + cloud). A widely-used
// Japanese charting system that's really several descriptive lines at
// once: Tenkan (9-period mid), Kijun (26-period mid), Senkou A/B (the
// "cloud," projected 26 periods forward), Chikou (close, shifted back).
// Returned as current readings + whether price sits above/inside/below
// the cloud — a common way traders describe trend context, still
// descriptive rather than predictive.
function ichimoku(highs, lows, closes) {
  const n = closes.length;
  const midOfRange = (period, i) => {
    if (i < period - 1) return null;
    const h = Math.max(...highs.slice(i - period + 1, i + 1));
    const l = Math.min(...lows.slice(i - period + 1, i + 1));
    return (h + l) / 2;
  };
  const tenkan = new Array(n).fill(null);
  const kijun = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    tenkan[i] = midOfRange(9, i);
    kijun[i] = midOfRange(26, i);
  }
  const senkouA = tenkan.map((t, i) => (t != null && kijun[i] != null ? (t + kijun[i]) / 2 : null));
  const senkouB = new Array(n).fill(null);
  for (let i = 0; i < n; i++) senkouB[i] = midOfRange(52, i);

  const li = n - 1;
  const cloudTop = senkouA[li] != null && senkouB[li] != null ? Math.max(senkouA[li], senkouB[li]) : null;
  const cloudBottom = senkouA[li] != null && senkouB[li] != null ? Math.min(senkouA[li], senkouB[li]) : null;
  let position = 'unknown';
  if (cloudTop != null && cloudBottom != null) {
    position = closes[li] > cloudTop ? 'above_cloud' : closes[li] < cloudBottom ? 'below_cloud' : 'inside_cloud';
  }
  return {
    tenkan: last(tenkan), kijun: last(kijun),
    senkouA: senkouA[li], senkouB: senkouB[li],
    cloudTop, cloudBottom, position,
    tkCross: tenkan[li] != null && kijun[li] != null ? (tenkan[li] > kijun[li] ? 'tenkan_above_kijun' : tenkan[li] < kijun[li] ? 'tenkan_below_kijun' : 'flat') : null,
  };
}

// Fibonacci retracement levels over the trailing swing high/low. These are
// pure arithmetic on the recent range (23.6/38.2/50/61.8/78.6%) — a
// commonly-watched reference grid, not a claim that price respects them.
// `lookback` controls what counts as "the recent swing."
function fibonacciLevels(closes, highs, lows, lookback = 90) {
  const n = closes.length;
  if (n < 5) return null;
  const start = Math.max(0, n - lookback);
  const hSlice = (highs && highs.length === n ? highs : closes).slice(start);
  const lSlice = (lows && lows.length === n ? lows : closes).slice(start);
  const swingHigh = Math.max(...hSlice);
  const swingLow = Math.min(...lSlice);
  const range = swingHigh - swingLow;
  if (!range) return null;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const uptrend = closes[n - 1] >= closes[start]; // rough direction of the swing, for labeling only
  const levels = ratios.map((r) => ({
    ratio: r,
    price: Math.round((uptrend ? swingHigh - range * r : swingLow + range * r) * 100) / 100,
  }));
  return { swingHigh, swingLow, direction: uptrend ? 'up' : 'down', levels };
}

// ATR expressed as a percentile against its own trailing history — "is
// current volatility high or low *for this asset*," since raw ATR isn't
// comparable across assets with different price levels. This is a
// volatility-regime read, not a direction call: high-vol regimes can be
// trending or choppy, low-vol regimes can precede either a breakout or
// more quiet.
function atrPercentileRegime(atrSeries, lookback = 90) {
  const clean = atrSeries.filter((v) => v != null);
  if (clean.length < 20) return null;
  const current = clean[clean.length - 1];
  const window = clean.slice(-lookback);
  const below = window.filter((v) => v < current).length;
  const percentile = Math.round((below / window.length) * 100);
  const regime = percentile >= 80 ? 'high_volatility' : percentile <= 20 ? 'low_volatility' : 'normal_volatility';
  return { current: Math.round(current * 100) / 100, percentile, regime };
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

  // -- newly added indicators --
  const obvSeries = volumes && volumes.length === closes.length ? obv(closes, volumes) : null;
  let obvTrend = 'unknown';
  if (obvSeries) {
    const recent = obvSeries.slice(-10).filter((v) => v != null);
    if (recent.length >= 2) obvTrend = recent[recent.length - 1] > recent[0] ? 'rising' : recent[recent.length - 1] < recent[0] ? 'falling' : 'flat';
  }

  const vwapSeries = volumes && volumes.length === closes.length ? rollingVwap(closes, volumes, highs, lows, 20) : null;
  const latestVwap = vwapSeries ? last(vwapSeries) : null;

  let adxRes = { adx: [], plusDI: [], minusDI: [] };
  let cciSeries = [];
  let willRSeries = [];
  let ichi = null;
  if (hasOhlc) {
    adxRes = adx(highs, lows, closes, 14);
    cciSeries = cci(highs, lows, closes, 20);
    willRSeries = williamsR(highs, lows, closes, 14);
    ichi = ichimoku(highs, lows, closes);
  }
  const latestAdx = last(adxRes.adx);
  const latestPlusDI = last(adxRes.plusDI);
  const latestMinusDI = last(adxRes.minusDI);
  const latestCci = last(cciSeries);
  const latestWillR = last(willRSeries);

  const fib = fibonacciLevels(closes, hasOhlc ? highs : null, hasOhlc ? lows : null, 90);
  const volRegime = hasOhlc ? atrPercentileRegime(atr(highs, lows, closes, 14), 90) : null;

  const confluence = computeConfluence({
    trend, latestRsi, latestHist, volumeSpike, bollPosition, latestStochK, stochZone,
    obvTrend, latestAdx, latestPlusDI, latestMinusDI, latestCci, latestWillR, ichi,
  });

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
    obv: obvSeries ? { trend: obvTrend } : null,
    vwap: latestVwap != null ? Math.round(latestVwap * 100) / 100 : null,
    adx: latestAdx != null ? {
      value: Math.round(latestAdx * 10) / 10,
      plusDI: latestPlusDI != null ? Math.round(latestPlusDI * 10) / 10 : null,
      minusDI: latestMinusDI != null ? Math.round(latestMinusDI * 10) / 10 : null,
      strength: latestAdx >= 40 ? 'strong_trend' : latestAdx >= 25 ? 'trending' : latestAdx >= 20 ? 'developing' : 'range_bound',
    } : null,
    cci: latestCci != null ? Math.round(latestCci * 10) / 10 : null,
    williamsR: latestWillR != null ? Math.round(latestWillR * 10) / 10 : null,
    ichimoku: ichi,
    fibonacci: fib,
    volatilityRegime: volRegime,
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
function computeConfluence({
  trend, latestRsi, latestHist, volumeSpike, bollPosition, latestStochK, stochZone,
  obvTrend, latestAdx, latestPlusDI, latestMinusDI, latestCci, latestWillR, ichi,
}) {
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

  if (obvTrend && obvTrend !== 'unknown') {
    readings.push({
      indicator: 'obv',
      detail: `On-balance volume ${obvTrend}`,
      // OBV direction describes whether volume has skewed toward up-days or
      // down-days recently — a participation reading, weighed lightly.
      lean: obvTrend === 'rising' ? 'up' : obvTrend === 'falling' ? 'down' : 'flat',
    });
  }

  // ADX is trend-STRENGTH, not direction — it only contributes a lean when
  // it's actually confirming a trend (>=20); below that it's explicitly
  // "range-bound" and contributes nothing directional, since a strong
  // reading in a non-trending market would be misleading.
  if (latestAdx != null) {
    if (latestAdx >= 20 && latestPlusDI != null && latestMinusDI != null) {
      readings.push({
        indicator: 'adx',
        detail: `ADX ${Math.round(latestAdx * 10) / 10} (${latestAdx >= 40 ? 'strong trend' : latestAdx >= 25 ? 'trending' : 'developing trend'}), +DI ${latestPlusDI > latestMinusDI ? 'above' : 'below'} -DI`,
        lean: latestPlusDI > latestMinusDI ? 'up' : 'down',
      });
    } else {
      readings.push({ indicator: 'adx', detail: `ADX ${Math.round(latestAdx * 10) / 10} (range-bound, no clear trend)`, lean: 'flat' });
    }
  }

  if (latestCci != null) {
    const zone = latestCci >= 100 ? 'overbought' : latestCci <= -100 ? 'oversold' : 'neutral';
    readings.push({
      indicator: 'cci',
      detail: `CCI ${Math.round(latestCci * 10) / 10} (${zone})`,
      lean: zone === 'overbought' ? 'up' : zone === 'oversold' ? 'down' : 'flat',
    });
  }

  if (latestWillR != null) {
    const zone = latestWillR >= -20 ? 'overbought' : latestWillR <= -80 ? 'oversold' : 'neutral';
    readings.push({
      indicator: 'williams_r',
      detail: `Williams %R ${Math.round(latestWillR * 10) / 10} (${zone})`,
      lean: zone === 'overbought' ? 'up' : zone === 'oversold' ? 'down' : 'flat',
    });
  }

  if (ichi && ichi.position !== 'unknown') {
    readings.push({
      indicator: 'ichimoku',
      detail: `Price ${ichi.position.replace('_', ' ')}${ichi.tkCross ? `, ${ichi.tkCross.replace(/_/g, ' ')}` : ''}`,
      lean: ichi.position === 'above_cloud' ? 'up' : ichi.position === 'below_cloud' ? 'down' : 'flat',
    });
  }

  const up = readings.filter((r) => r.lean === 'up').length;
  const down = readings.filter((r) => r.lean === 'down').length;
  const flat = readings.length - up - down;

  return { up, down, flat, total: readings.length, readings };
}

module.exports = {
  sma, ema, rsi, macd, bollinger, atr, stochastic, obv, rollingVwap, adx, cci, williamsR,
  ichimoku, fibonacciLevels, atrPercentileRegime, computeIndicators, computeConfluence, rsiZone,
};
