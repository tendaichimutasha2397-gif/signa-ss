// Plain technical-indicator math over a closing-price series. Descriptive
// statistics about price history only — not signals, not recommendations.
// Every function returns null-padded arrays aligned with the input so the
// caller can diff consecutive snapshots cleanly.

'use strict';

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
    // Skip nulls without resetting the accumulator
    if (values[i] == null) continue;
    if (prev == null) {
      if (i >= period - 1) {
        let seed = 0;
        let count = 0;
        for (let j = i - period + 1; j <= i; j++) {
          if (values[j] != null) { seed += values[j]; count++; }
        }
        if (count === period) { prev = seed / period; out[i] = prev; }
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder RSI. Null-padded until enough history exists.
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gainSum = 0, lossSum = 0;
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

// MACD with correct null-propagation. Prior implementation seeded signal EMA
// with 0 for null MACD values, which corrupted the first N signal readings.
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  // MACD line: null wherever either EMA isn't ready yet
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  // Signal: EMA only over the non-null portion of macdLine
  const signalLine = new Array(values.length).fill(null);
  const validStart = macdLine.findIndex(v => v != null);
  if (validStart >= 0) {
    const slice = macdLine.slice(validStart).map(v => v ?? 0);
    const sliceEma = ema(slice, signalPeriod);
    for (let i = 0; i < sliceEma.length; i++) {
      if (sliceEma[i] != null && macdLine[validStart + i] != null) {
        signalLine[validStart + i] = sliceEma[i];
      }
    }
  }
  const hist = macdLine.map((v, i) =>
    v != null && signalLine[i] != null ? v - signalLine[i] : null
  );
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

// Bollinger Bands: SMA(period) ± mult·σ.
// squeeze flag: current width is below its own 20-bar SMA (bands unusually
// narrow vs recent history). Descriptive volatility observation only.
function bollinger(values, period = 20, mult = 2) {
  const basis = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  const width  = new Array(values.length).fill(null);
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
  // Squeeze: width percentile over trailing 50 bars
  const widthSma = sma(width.map(v => v ?? 0), 20);
  const squeeze = width.map((w, i) =>
    w != null && widthSma[i] != null ? w < widthSma[i] : null
  );
  return { basis, upper, lower, width, squeeze };
}

// ATR (Wilder-smoothed). Requires OHLC — returns all-null when highs/lows absent.
function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (!highs || !lows || n < period + 1) return out;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (highs[i] == null || lows[i] == null || closes[i - 1] == null) continue;
    const hl  = highs[i] - lows[i];
    const hc  = Math.abs(highs[i] - closes[i - 1]);
    const lc  = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  let sum = 0, count = 0;
  for (let i = 1; i <= period; i++) { if (tr[i] != null) { sum += tr[i]; count++; } }
  if (count < period) return out;
  let prevAtr = sum / period;
  out[period] = prevAtr;
  for (let i = period + 1; i < n; i++) {
    if (tr[i] == null) { out[i] = prevAtr; continue; }
    prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

// Stochastic %K/%D. Uses explicit loop instead of spread to avoid
// call-stack overflow on long series (Math.max(...array) with 1000+ elements
// throws on some V8 versions).
function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const n = closes.length;
  const k = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    if (closes[i] == null) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] != null && highs[j] > hh) hh = highs[j];
      if (lows[j] != null && lows[j] < ll)  ll = lows[j];
    }
    k[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  // %D = SMA(3) over %K; null-propagated
  const kFilled = k.map(v => v ?? 0);
  const d = sma(kFilled, dPeriod);
  for (let i = 0; i < n; i++) if (k[i] == null) d[i] = null;
  return { k, d };
}

// OBV: running cumulative volume. Slope over trailing window is what matters.
function obv(closes, volumes) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (!volumes || volumes.length !== n) return out;
  let running = 0;
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1])      running += volumes[i];
    else if (closes[i] < closes[i - 1]) running -= volumes[i];
    out[i] = running;
  }
  return out;
}

// Rolling VWAP anchored to a trailing window (not session-reset).
// Uses typical price when H/L available; falls back to close.
function rollingVwap(closes, volumes, highs, lows, period = 20) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (!volumes || volumes.length !== n) return out;
  const hasHL = Array.isArray(highs) && Array.isArray(lows) && highs.length === n && lows.length === n;
  const typical = closes.map((c, i) =>
    hasHL && highs[i] != null && lows[i] != null ? (highs[i] + lows[i] + c) / 3 : c
  );
  for (let i = period - 1; i < n; i++) {
    let pvSum = 0, vSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      pvSum += typical[j] * (volumes[j] || 0);
      vSum  += volumes[j] || 0;
    }
    out[i] = vSum ? pvSum / vSum : null;
  }
  return out;
}

// ADX / +DI / -DI (Wilder). Measures trend STRENGTH — a genuinely different
// axis from SMA direction. ADX < 20 = weak/no trend; 20-25 = developing;
// 25+ = trending; 40+ = strong trend.
function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const outAdx    = new Array(n).fill(null);
  const outPlusDI = new Array(n).fill(null);
  const outMinusDI = new Array(n).fill(null);
  if (!highs || !lows || n < period * 2 + 1) return { adx: outAdx, plusDI: outPlusDI, minusDI: outMinusDI };

  const plusDM  = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr      = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (highs[i] == null || lows[i] == null || highs[i-1] == null || lows[i-1] == null) continue;
    const upMove   = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i]  = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  let smTr = 0, smPlusDM = 0, smMinusDM = 0;
  for (let i = 1; i <= period; i++) { smTr += tr[i]; smPlusDM += plusDM[i]; smMinusDM += minusDM[i]; }

  const dxSeries = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      smTr      = smTr - smTr / period + tr[i];
      smPlusDM  = smPlusDM - smPlusDM / period + plusDM[i];
      smMinusDM = smMinusDM - smMinusDM / period + minusDM[i];
    }
    const pDI = smTr ? (smPlusDM / smTr) * 100 : 0;
    const mDI = smTr ? (smMinusDM / smTr) * 100 : 0;
    outPlusDI[i]  = pDI;
    outMinusDI[i] = mDI;
    dxSeries[i] = pDI + mDI ? (Math.abs(pDI - mDI) / (pDI + mDI)) * 100 : 0;
  }

  let adxPrev = null;
  for (let i = period; i < n; i++) {
    if (dxSeries[i] == null) continue;
    if (adxPrev == null) {
      const window = dxSeries.slice(i - period + 1, i + 1).filter(v => v != null);
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

// CCI: how far typical price sits from its moving average in mean-deviation units.
// |CCI| > 100 = stretched vs recent average. Descriptive only.
function cci(highs, lows, closes, period = 20) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  const hasHL = Array.isArray(highs) && Array.isArray(lows) && highs.length === n && lows.length === n;
  const typical = closes.map((c, i) => hasHL ? (highs[i] + lows[i] + c) / 3 : c);
  for (let i = period - 1; i < n; i++) {
    const slice = typical.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const meanDev = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    out[i] = meanDev ? (typical[i] - mean) / (0.015 * meanDev) : 0;
  }
  return out;
}

// Williams %R: inverted Stochastic. Range 0 to -100.
// Overbought: above -20 (close near recent high). Oversold: below -80.
function williamsR(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    if (closes[i] == null) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] != null && highs[j] > hh) hh = highs[j];
      if (lows[j] != null && lows[j] < ll)  ll = lows[j];
    }
    out[i] = hh === ll ? -50 : ((hh - closes[i]) / (hh - ll)) * -100;
  }
  return out;
}

// Ichimoku Kinko Hyo. Returns current scalar readings + cloud position.
function ichimoku(highs, lows, closes) {
  const n = closes.length;
  const midOfRange = (period, i) => {
    if (i < period - 1) return null;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] != null && highs[j] > hh) hh = highs[j];
      if (lows[j] != null && lows[j] < ll)  ll = lows[j];
    }
    return hh === -Infinity ? null : (hh + ll) / 2;
  };
  const tenkan = new Array(n).fill(null);
  const kijun  = new Array(n).fill(null);
  for (let i = 0; i < n; i++) { tenkan[i] = midOfRange(9, i); kijun[i] = midOfRange(26, i); }
  const senkouA = tenkan.map((t, i) => t != null && kijun[i] != null ? (t + kijun[i]) / 2 : null);
  const senkouB = new Array(n).fill(null);
  for (let i = 0; i < n; i++) senkouB[i] = midOfRange(52, i);

  const li = n - 1;
  const cloudTop    = senkouA[li] != null && senkouB[li] != null ? Math.max(senkouA[li], senkouB[li]) : null;
  const cloudBottom = senkouA[li] != null && senkouB[li] != null ? Math.min(senkouA[li], senkouB[li]) : null;
  let position = 'unknown';
  if (cloudTop != null && cloudBottom != null) {
    position = closes[li] > cloudTop ? 'above_cloud' : closes[li] < cloudBottom ? 'below_cloud' : 'inside_cloud';
  }
  return {
    tenkan: last(tenkan), kijun: last(kijun),
    senkouA: senkouA[li], senkouB: senkouB[li],
    cloudTop, cloudBottom, position,
    tkCross: tenkan[li] != null && kijun[li] != null
      ? (tenkan[li] > kijun[li] ? 'tenkan_above_kijun' : tenkan[li] < kijun[li] ? 'tenkan_below_kijun' : 'flat')
      : null,
  };
}

// Fibonacci retracement levels over trailing swing. Pure arithmetic on
// the observed range — a commonly-watched reference grid, not a claim.
function fibonacciLevels(closes, highs, lows, lookback = 90) {
  const n = closes.length;
  if (n < 5) return null;
  const start = Math.max(0, n - lookback);
  const hSlice = (highs && highs.length === n ? highs : closes).slice(start);
  const lSlice = (lows && lows.length === n ? lows : closes).slice(start);
  let swingHigh = -Infinity, swingLow = Infinity;
  for (let i = 0; i < hSlice.length; i++) {
    if (hSlice[i] != null && hSlice[i] > swingHigh) swingHigh = hSlice[i];
    if (lSlice[i] != null && lSlice[i] < swingLow)  swingLow  = lSlice[i];
  }
  if (!isFinite(swingHigh) || !isFinite(swingLow)) return null;
  const range = swingHigh - swingLow;
  if (!range) return null;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const uptrend = closes[n - 1] >= closes[start];
  const levels = ratios.map(r => ({
    ratio: r,
    price: Math.round((uptrend ? swingHigh - range * r : swingLow + range * r) * 100) / 100,
  }));
  return { swingHigh, swingLow, direction: uptrend ? 'up' : 'down', levels };
}

// ATR percentile vs the asset's own recent history. Guards against edge case
// where the entire window is identical (zero variance — returns percentile 50).
function atrPercentileRegime(atrSeries, lookback = 90) {
  const clean = atrSeries.filter(v => v != null);
  if (clean.length < 20) return null;
  const current = clean[clean.length - 1];
  const window = clean.slice(-lookback);
  const below = window.filter(v => v < current).length;
  const percentile = window.length > 0 ? Math.round((below / window.length) * 100) : 50;
  const regime = percentile >= 80 ? 'high_volatility' : percentile <= 20 ? 'low_volatility' : 'normal_volatility';
  return { current: Math.round(current * 100) / 100, percentile, regime };
}

/**
 * Full indicator snapshot for one asset. Null-safe throughout — a missing
 * OHLC source simply leaves ATR/Stochastic/ADX/CCI/Williams/Ichimoku as
 * null rather than approximating from close-only data (which would be wrong).
 */
function computeIndicators(closes, volumes = [], highs = null, lows = null) {
  if (!closes || closes.length < 2) return null;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsiSeries = rsi(closes, 14);
  const macdRes  = macd(closes);
  const boll     = bollinger(closes, 20, 2);

  const latestClose     = last(closes);
  const latestSma20     = last(sma20);
  const latestSma50     = last(sma50);
  const latestRsi       = last(rsiSeries);
  const latestHist      = last(macdRes.hist);
  const latestBollUpper = last(boll.upper);
  const latestBollLower = last(boll.lower);
  const latestBollWidth = last(boll.width);
  const latestBollSqueeze = last(boll.squeeze);

  let bollPosition = null;
  if (latestBollUpper != null && latestBollLower != null) {
    if (latestClose >= latestBollUpper)      bollPosition = 'at_or_above_upper';
    else if (latestClose <= latestBollLower) bollPosition = 'at_or_below_lower';
    else                                     bollPosition = 'inside_bands';
  }

  const hasOhlc = Array.isArray(highs) && Array.isArray(lows)
    && highs.length === closes.length && lows.length === closes.length
    && highs.some(v => v != null) && lows.some(v => v != null);

  let latestAtr    = null;
  let latestStochK = null;
  let latestStochD = null;
  let stochZone    = 'unknown';
  let adxRes       = { adx: [], plusDI: [], minusDI: [] };
  let cciSeries    = [];
  let willRSeries  = [];
  let ichi         = null;
  let volRegime    = null;

  if (hasOhlc) {
    const atrSeries = atr(highs, lows, closes, 14);
    latestAtr  = last(atrSeries);
    volRegime  = atrPercentileRegime(atrSeries, 90);
    const stoch = stochastic(highs, lows, closes, 14, 3);
    latestStochK = last(stoch.k);
    latestStochD = last(stoch.d);
    stochZone = latestStochK != null
      ? (latestStochK >= 80 ? 'overbought' : latestStochK <= 20 ? 'oversold' : 'neutral')
      : 'unknown';
    adxRes     = adx(highs, lows, closes, 14);
    cciSeries  = cci(highs, lows, closes, 20);
    willRSeries = williamsR(highs, lows, closes, 14);
    ichi       = ichimoku(highs, lows, closes);
  }

  const latestAdx     = last(adxRes.adx);
  const latestPlusDI  = last(adxRes.plusDI);
  const latestMinusDI = last(adxRes.minusDI);
  const latestCci     = last(cciSeries);
  const latestWillR   = last(willRSeries);

  let trend = 'neutral';
  if (latestSma20 != null && latestSma50 != null) {
    trend = latestSma20 > latestSma50 ? 'bullish' : latestSma20 < latestSma50 ? 'bearish' : 'neutral';
  }

  let volumeSpike = null;
  if (volumes && volumes.length >= 5) {
    const recent = volumes[volumes.length - 1];
    const priorWindow = volumes.slice(-21, -1).filter(v => v != null && v > 0);
    if (priorWindow.length) {
      const avg = priorWindow.reduce((a, b) => a + b, 0) / priorWindow.length;
      volumeSpike = {
        current: recent,
        avg,
        ratio: avg ? Math.round((recent / avg) * 100) / 100 : null,
        isSpike: avg ? recent > avg * 2 : false,
      };
    }
  }

  const obvSeries = volumes && volumes.length === closes.length ? obv(closes, volumes) : null;
  let obvTrend = 'unknown';
  if (obvSeries) {
    const recent = obvSeries.slice(-10).filter(v => v != null);
    if (recent.length >= 2) {
      obvTrend = recent[recent.length - 1] > recent[0] ? 'rising'
               : recent[recent.length - 1] < recent[0] ? 'falling' : 'flat';
    }
  }

  const vwapSeries = volumes && volumes.length === closes.length
    ? rollingVwap(closes, volumes, highs, lows, 20) : null;
  const latestVwap = vwapSeries ? last(vwapSeries) : null;

  const fib = fibonacciLevels(closes, hasOhlc ? highs : null, hasOhlc ? lows : null, 90);

  const confluence = computeConfluence({
    trend, latestRsi, latestHist, volumeSpike, bollPosition, latestStochK, stochZone,
    obvTrend, latestAdx, latestPlusDI, latestMinusDI, latestCci, latestWillR, ichi,
    latestClose, latestVwap,
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
      squeeze: latestBollSqueeze,
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
      strength: latestAdx >= 40 ? 'strong_trend' : latestAdx >= 25 ? 'trending'
              : latestAdx >= 20 ? 'developing' : 'range_bound',
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
 * Tally each indicator's current lean: up / down / flat.
 *
 * IMPORTANT CORRECTION from original: RSI overbought (≥70) and Stochastic
 * overbought both lean DOWN — price is stretched high and statistically more
 * likely to mean-revert (or at minimum has less upside buffer). The original
 * implementation incorrectly assigned 'up' to overbought zones. Same applies
 * to CCI >100 and Williams %R >-20. Bollinger at-upper is left 'flat' rather
 * than directional because band touches are ambiguous (can be breakout OR
 * exhaustion). VWAP position contributes: price above VWAP = bullish flow.
 *
 * This is still a COUNT, not a verdict. The caller/UI must present it as
 * "X readings lean up / Y lean down / Z flat" with individual detail lines
 * inspectable — never as a buy/sell conclusion.
 */
function computeConfluence({
  trend, latestRsi, latestHist, volumeSpike, bollPosition, latestStochK, stochZone,
  obvTrend, latestAdx, latestPlusDI, latestMinusDI, latestCci, latestWillR, ichi,
  latestClose, latestVwap,
}) {
  const readings = [];

  // SMA trend
  readings.push({
    indicator: 'sma_trend',
    detail: trend === 'bullish' ? 'SMA20 above SMA50' : trend === 'bearish' ? 'SMA20 below SMA50' : 'SMA20/50 flat',
    lean: trend === 'bullish' ? 'up' : trend === 'bearish' ? 'down' : 'flat',
  });

  // RSI — corrected: overbought leans DOWN (stretched high, less room up)
  if (latestRsi != null) {
    const zone = rsiZone(latestRsi);
    readings.push({
      indicator: 'rsi',
      detail: `RSI ${Math.round(latestRsi * 10) / 10} (${zone})`,
      lean: zone === 'overbought' ? 'down' : zone === 'oversold' ? 'up' : 'flat',
    });
  } else {
    readings.push({ indicator: 'rsi', detail: 'not enough history', lean: 'flat' });
  }

  // MACD histogram sign
  if (latestHist != null) {
    readings.push({
      indicator: 'macd_histogram',
      detail: `MACD histogram ${latestHist > 0 ? 'positive' : latestHist < 0 ? 'negative' : 'flat'} (${Math.round(latestHist * 10000) / 10000})`,
      lean: latestHist > 0 ? 'up' : latestHist < 0 ? 'down' : 'flat',
    });
  } else {
    readings.push({ indicator: 'macd_histogram', detail: 'not enough history', lean: 'flat' });
  }

  // Bollinger — band touches are ambiguous; inside is flat; only extreme
  // stretches get a lean (and even then we call it down for upper, up for lower
  // since it describes mean-reversion pressure, not momentum direction).
  if (bollPosition) {
    readings.push({
      indicator: 'bollinger',
      detail: bollPosition === 'at_or_above_upper' ? 'price at/above upper band'
            : bollPosition === 'at_or_below_lower' ? 'price at/below lower band'
            : 'price inside the bands',
      lean: bollPosition === 'at_or_above_upper' ? 'down'
          : bollPosition === 'at_or_below_lower' ? 'up'
          : 'flat',
    });
  }

  // Stochastic — overbought leans DOWN (same logic as RSI)
  if (latestStochK != null) {
    readings.push({
      indicator: 'stochastic',
      detail: `Stoch %K ${Math.round(latestStochK * 10) / 10} (${stochZone})`,
      lean: stochZone === 'overbought' ? 'down' : stochZone === 'oversold' ? 'up' : 'flat',
    });
  }

  // Volume — flat always; no directional information in volume alone
  if (volumeSpike) {
    readings.push({
      indicator: 'volume',
      detail: volumeSpike.isSpike
        ? `volume ${volumeSpike.ratio?.toFixed(1)}x average (elevated activity, direction unknown)`
        : 'volume near average',
      lean: 'flat',
    });
  }

  // OBV slope
  if (obvTrend && obvTrend !== 'unknown') {
    readings.push({
      indicator: 'obv',
      detail: `On-balance volume ${obvTrend}`,
      lean: obvTrend === 'rising' ? 'up' : obvTrend === 'falling' ? 'down' : 'flat',
    });
  }

  // ADX: only directional above 20; below that it's range-bound (flat)
  if (latestAdx != null) {
    if (latestAdx >= 20 && latestPlusDI != null && latestMinusDI != null) {
      readings.push({
        indicator: 'adx',
        detail: `ADX ${Math.round(latestAdx * 10) / 10} (${latestAdx >= 40 ? 'strong trend' : latestAdx >= 25 ? 'trending' : 'developing'}), +DI ${latestPlusDI > latestMinusDI ? 'above' : 'below'} -DI`,
        lean: latestPlusDI > latestMinusDI ? 'up' : 'down',
      });
    } else {
      readings.push({ indicator: 'adx', detail: `ADX ${Math.round(latestAdx * 10) / 10} (range-bound)`, lean: 'flat' });
    }
  }

  // CCI — corrected: >100 is overbought → lean DOWN
  if (latestCci != null) {
    const zone = latestCci >= 100 ? 'overbought' : latestCci <= -100 ? 'oversold' : 'neutral';
    readings.push({
      indicator: 'cci',
      detail: `CCI ${Math.round(latestCci * 10) / 10} (${zone})`,
      lean: zone === 'overbought' ? 'down' : zone === 'oversold' ? 'up' : 'flat',
    });
  }

  // Williams %R — overbought = above -20 → lean DOWN
  if (latestWillR != null) {
    const zone = latestWillR >= -20 ? 'overbought' : latestWillR <= -80 ? 'oversold' : 'neutral';
    readings.push({
      indicator: 'williams_r',
      detail: `Williams %R ${Math.round(latestWillR * 10) / 10} (${zone})`,
      lean: zone === 'overbought' ? 'down' : zone === 'oversold' ? 'up' : 'flat',
    });
  }

  // Ichimoku cloud position
  if (ichi && ichi.position !== 'unknown') {
    readings.push({
      indicator: 'ichimoku',
      detail: `Price ${ichi.position.replace(/_/g, ' ')}${ichi.tkCross ? `, ${ichi.tkCross.replace(/_/g, ' ')}` : ''}`,
      lean: ichi.position === 'above_cloud' ? 'up' : ichi.position === 'below_cloud' ? 'down' : 'flat',
    });
  }

  // VWAP position: price above/below 20-day volume-weighted average
  if (latestClose != null && latestVwap != null) {
    readings.push({
      indicator: 'vwap',
      detail: `Price ${latestClose > latestVwap ? 'above' : latestClose < latestVwap ? 'below' : 'at'} VWAP(20) $${Math.round(latestVwap * 100) / 100}`,
      lean: latestClose > latestVwap ? 'up' : latestClose < latestVwap ? 'down' : 'flat',
    });
  }

  const up   = readings.filter(r => r.lean === 'up').length;
  const down = readings.filter(r => r.lean === 'down').length;
  const flat = readings.length - up - down;

  return { up, down, flat, total: readings.length, readings };
}

module.exports = {
  sma, ema, rsi, macd, bollinger, atr, stochastic, obv, rollingVwap, adx, cci, williamsR,
  ichimoku, fibonacciLevels, atrPercentileRegime, computeIndicators, computeConfluence, rsiZone,
};
