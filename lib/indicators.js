'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// INDICATOR LIBRARY
// Pure math over price series. Every function returns null-padded arrays
// aligned with the input — caller can diff consecutive snapshots cleanly.
// Nothing here is a buy/sell signal; these are descriptive statistics.
// ─────────────────────────────────────────────────────────────────────────────

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
      if (i >= period - 1) {
        let seed = 0, count = 0;
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

// Double EMA — faster response than EMA, less lag
function dema(values, period) {
  const e1 = ema(values, period);
  const e2 = ema(e1.map(v => v ?? 0), period);
  return values.map((_, i) => (e1[i] != null && e2[i] != null ? 2 * e1[i] - e2[i] : null));
}

// Triple EMA — fastest EMA variant
function tema(values, period) {
  const e1 = ema(values, period);
  const e2 = ema(e1.map(v => v ?? 0), period);
  const e3 = ema(e2.map(v => v ?? 0), period);
  return values.map((_, i) =>
    e1[i] != null && e2[i] != null && e3[i] != null ? 3 * e1[i] - 3 * e2[i] + e3[i] : null
  );
}

// Wilder RSI — null-padded until enough history
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
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

// MACD with correct null-propagation (no zero-seeding corruption)
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const signalLine = new Array(values.length).fill(null);
  const validStart = macdLine.findIndex(v => v != null);
  if (validStart >= 0) {
    const slice = macdLine.slice(validStart).map(v => v ?? 0);
    const sliceEma = ema(slice, signalPeriod);
    for (let i = 0; i < sliceEma.length; i++) {
      if (sliceEma[i] != null && macdLine[validStart + i] != null)
        signalLine[validStart + i] = sliceEma[i];
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

// Bollinger Bands with squeeze detection
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
  const widthSma = sma(width.map(v => v ?? 0), 20);
  const squeeze = width.map((w, i) =>
    w != null && widthSma[i] != null ? w < widthSma[i] : null
  );
  return { basis, upper, lower, width, squeeze };
}

// Keltner Channels — ATR-based bands around EMA(20)
// Price outside Keltner but inside Bollinger = squeeze setup
function keltner(closes, highs, lows, period = 20, mult = 1.5) {
  const n = closes.length;
  const basis = ema(closes, period);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  if (!highs || !lows) return { basis, upper, lower };
  const atrSeries = atr(highs, lows, closes, period);
  for (let i = 0; i < n; i++) {
    if (basis[i] == null || atrSeries[i] == null) continue;
    upper[i] = basis[i] + mult * atrSeries[i];
    lower[i] = basis[i] - mult * atrSeries[i];
  }
  return { basis, upper, lower };
}

// ATR — Wilder-smoothed, null-safe
function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (!highs || !lows || n < period + 1) return out;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (highs[i] == null || lows[i] == null || closes[i - 1] == null) continue;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
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

// Stochastic — stack-safe (explicit loop, no spread)
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
  const d = sma(k.map(v => v ?? 0), dPeriod);
  for (let i = 0; i < n; i++) if (k[i] == null) d[i] = null;
  return { k, d };
}

// OBV: running cumulative volume
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

// Money Flow Index — RSI of money flow (volume-weighted)
function mfi(highs, lows, closes, volumes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (!highs || !lows || !volumes || n < period + 1) return out;
  const typical = closes.map((c, i) =>
    highs[i] != null && lows[i] != null ? (highs[i] + lows[i] + c) / 3 : c
  );
  const rawMF = typical.map((tp, i) => tp * (volumes[i] || 0));
  for (let i = period; i < n; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (typical[j] > typical[j - 1]) posFlow += rawMF[j];
      else if (typical[j] < typical[j - 1]) negFlow += rawMF[j];
    }
    out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return out;
}

// Rate of Change — momentum oscillator, % change over N periods
function roc(values, period = 10) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (values[i - period] == null || values[i - period] === 0) continue;
    out[i] = ((values[i] - values[i - period]) / values[i - period]) * 100;
  }
  return out;
}

// Chande Momentum Oscillator — like RSI but symmetrical around zero
function cmo(values, period = 14) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let su = 0, sd = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j] - values[j - 1];
      if (diff > 0) su += diff;
      else sd -= diff;
    }
    out[i] = su + sd === 0 ? 0 : ((su - sd) / (su + sd)) * 100;
  }
  return out;
}

// Aroon Oscillator — measures how recently swing highs/lows occurred
function aroon(highs, lows, period = 25) {
  const n = highs.length;
  const aroonUp   = new Array(n).fill(null);
  const aroonDown = new Array(n).fill(null);
  const osc       = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let maxH = -Infinity, minL = Infinity, maxI = 0, minI = 0;
    for (let j = i - period; j <= i; j++) {
      if (highs[j] != null && highs[j] > maxH) { maxH = highs[j]; maxI = j; }
      if (lows[j] != null && lows[j] < minL)   { minL = lows[j];  minI = j; }
    }
    aroonUp[i]   = ((period - (i - maxI)) / period) * 100;
    aroonDown[i] = ((period - (i - minI)) / period) * 100;
    osc[i]       = aroonUp[i] - aroonDown[i];
  }
  return { up: aroonUp, down: aroonDown, osc };
}

// Parabolic SAR
function psar(highs, lows, step = 0.02, max = 0.2) {
  const n = highs.length;
  const out = new Array(n).fill(null);
  const trend = new Array(n).fill(null); // 1=up, -1=down
  if (n < 2) return { sar: out, trend };
  let bull = true;
  let af = step;
  let ep = highs[0];
  let sarVal = lows[0];
  for (let i = 1; i < n; i++) {
    const prevSar = sarVal;
    sarVal = prevSar + af * (ep - prevSar);
    if (bull) {
      sarVal = Math.min(sarVal, lows[i - 1], i >= 2 ? lows[i - 2] : lows[i - 1]);
      if (lows[i] < sarVal) {
        bull = false; sarVal = ep; ep = lows[i]; af = step;
      } else {
        if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + step, max); }
      }
    } else {
      sarVal = Math.max(sarVal, highs[i - 1], i >= 2 ? highs[i - 2] : highs[i - 1]);
      if (highs[i] > sarVal) {
        bull = true; sarVal = ep; ep = highs[i]; af = step;
      } else {
        if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + step, max); }
      }
    }
    out[i] = sarVal;
    trend[i] = bull ? 1 : -1;
  }
  return { sar: out, trend };
}

// Supertrend — ATR-based trailing stop/trend indicator
function supertrend(highs, lows, closes, period = 10, mult = 3) {
  const n = closes.length;
  const direction = new Array(n).fill(null);
  const line = new Array(n).fill(null);
  if (!highs || !lows || n < period + 1) return { direction, line };
  const atrSeries = atr(highs, lows, closes, period);
  const hl2 = closes.map((_, i) =>
    highs[i] != null && lows[i] != null ? (highs[i] + lows[i]) / 2 : null
  );
  const upperBand = hl2.map((m, i) => m != null && atrSeries[i] != null ? m + mult * atrSeries[i] : null);
  const lowerBand = hl2.map((m, i) => m != null && atrSeries[i] != null ? m - mult * atrSeries[i] : null);
  const finalUpper = [...upperBand];
  const finalLower = [...lowerBand];
  let trend = 1;
  for (let i = period; i < n; i++) {
    if (finalUpper[i] == null || finalLower[i] == null) continue;
    if (finalUpper[i - 1] != null) finalUpper[i] = Math.min(finalUpper[i], finalUpper[i - 1]);
    if (finalLower[i - 1] != null) finalLower[i] = Math.max(finalLower[i], finalLower[i - 1]);
    if (closes[i - 1] > (finalUpper[i - 1] ?? Infinity)) finalUpper[i] = upperBand[i];
    if (closes[i - 1] < (finalLower[i - 1] ?? -Infinity)) finalLower[i] = lowerBand[i];
    if (closes[i] > (finalUpper[i - 1] ?? -Infinity)) trend = 1;
    else if (closes[i] < (finalLower[i - 1] ?? Infinity)) trend = -1;
    direction[i] = trend;
    line[i] = trend === 1 ? finalLower[i] : finalUpper[i];
  }
  return { direction, line };
}

// Elder Ray — Bull Power and Bear Power
// Bull Power = High - EMA; Bear Power = Low - EMA
// Measures how far highs/lows extend from the trend baseline
function elderRay(highs, lows, closes, period = 13) {
  const n = closes.length;
  const emaSeries = ema(closes, period);
  const bullPower = new Array(n).fill(null);
  const bearPower = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaSeries[i] == null || highs[i] == null || lows[i] == null) continue;
    bullPower[i] = highs[i] - emaSeries[i];
    bearPower[i] = lows[i] - emaSeries[i];
  }
  return { bullPower, bearPower };
}

// Rolling VWAP anchored to trailing window
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

// ADX / +DI / -DI (Wilder)
function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const outAdx    = new Array(n).fill(null);
  const outPlusDI = new Array(n).fill(null);
  const outMinusDI = new Array(n).fill(null);
  if (!highs || !lows || n < period * 2 + 1) return { adx: outAdx, plusDI: outPlusDI, minusDI: outMinusDI };
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (highs[i] == null || lows[i] == null || highs[i-1] == null || lows[i-1] == null) continue;
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i]  = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
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

// CCI
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

// Williams %R (stack-safe)
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

// Ichimoku
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

// Fibonacci retracement (stack-safe)
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

// ATR percentile / volatility regime
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

// ─────────────────────────────────────────────────────────────────────────────
// DIVERGENCE DETECTION
// Classic RSI and MACD divergence — one of the highest-quality technical
// signals because it identifies disagreement between price and momentum.
// Requires finding local swing points then comparing their levels.
// ─────────────────────────────────────────────────────────────────────────────

// Find local highs/lows with a minimum lookback window on each side
function swingPoints(values, lookback = 5) {
  const highs = [];
  const lows  = [];
  for (let i = lookback; i < values.length - lookback; i++) {
    if (values[i] == null) continue;
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i || values[j] == null) continue;
      if (values[j] >= values[i]) isHigh = false;
      if (values[j] <= values[i]) isLow  = false;
    }
    if (isHigh) highs.push({ index: i, value: values[i] });
    if (isLow)  lows.push({ index: i, value: values[i] });
  }
  return { highs, lows };
}

/**
 * Detects RSI and MACD divergence over the trailing window.
 *
 * Bullish divergence: price makes a lower low, indicator makes a higher low
 *   → momentum not confirming the downtrend → potential reversal up
 * Bearish divergence: price makes a higher high, indicator makes a lower high
 *   → momentum not confirming the uptrend → potential reversal down
 *
 * Returns { rsi: { bullish, bearish }, macd: { bullish, bearish } }
 * each with a confidence level based on gap size and how recent the swing is.
 */
function detectDivergence(closes, rsiSeries, macdHistSeries, lookbackBars = 40) {
  const n = closes.length;
  const windowStart = Math.max(0, n - lookbackBars);

  const priceSlice = closes.slice(windowStart);
  const rsiSlice   = rsiSeries.slice(windowStart);
  const macdSlice  = macdHistSeries.slice(windowStart);

  const pSwings    = swingPoints(priceSlice, 3);
  const rsiSwings  = swingPoints(rsiSlice, 3);
  const macdSwings = swingPoints(macdSlice, 3);

  function checkBearishDiv(priceHighs, indHighs, label) {
    // Need at least 2 price highs and 2 indicator highs
    if (priceHighs.length < 2 || indHighs.length < 2) return null;
    const p1 = priceHighs[priceHighs.length - 2];
    const p2 = priceHighs[priceHighs.length - 1];
    // Find indicator highs closest to each price high
    const i1 = indHighs.reduce((best, h) => Math.abs(h.index - p1.index) < Math.abs(best.index - p1.index) ? h : best);
    const i2 = indHighs.reduce((best, h) => Math.abs(h.index - p2.index) < Math.abs(best.index - p2.index) ? h : best);
    if (p2.value > p1.value && i2.value < i1.value) {
      const pricePctGap = ((p2.value - p1.value) / p1.value) * 100;
      const indPctGap   = ((i1.value - i2.value) / Math.abs(i1.value)) * 100;
      const recency     = n - (windowStart + p2.index); // bars since last swing
      const confidence  = pricePctGap > 2 && indPctGap > 5 && recency < 10 ? 'high' : 'moderate';
      return { type: 'bearish', label, pricePctGap: Math.round(pricePctGap * 100)/100, confidence, barsAgo: recency };
    }
    return null;
  }

  function checkBullishDiv(priceLows, indLows, label) {
    if (priceLows.length < 2 || indLows.length < 2) return null;
    const p1 = priceLows[priceLows.length - 2];
    const p2 = priceLows[priceLows.length - 1];
    const i1 = indLows.reduce((best, l) => Math.abs(l.index - p1.index) < Math.abs(best.index - p1.index) ? l : best);
    const i2 = indLows.reduce((best, l) => Math.abs(l.index - p2.index) < Math.abs(best.index - p2.index) ? l : best);
    if (p2.value < p1.value && i2.value > i1.value) {
      const pricePctGap = ((p1.value - p2.value) / p1.value) * 100;
      const indPctGap   = ((i2.value - i1.value) / Math.abs(i1.value || 1)) * 100;
      const recency     = n - (windowStart + p2.index);
      const confidence  = pricePctGap > 2 && indPctGap > 5 && recency < 10 ? 'high' : 'moderate';
      return { type: 'bullish', label, pricePctGap: Math.round(pricePctGap * 100)/100, confidence, barsAgo: recency };
    }
    return null;
  }

  const rsiDiv  = checkBullishDiv(pSwings.lows, rsiSwings.lows, 'RSI bullish divergence')
                || checkBearishDiv(pSwings.highs, rsiSwings.highs, 'RSI bearish divergence')
                || null;
  const macdDiv = checkBullishDiv(pSwings.lows, macdSwings.lows, 'MACD bullish divergence')
                || checkBearishDiv(pSwings.highs, macdSwings.highs, 'MACD bearish divergence')
                || null;

  return { rsi: rsiDiv, macd: macdDiv };
}

// ─────────────────────────────────────────────────────────────────────────────
// PIVOT POINTS (Standard / Floor Trader pivots)
// Computed from the prior period's H/L/C. A commonly-used reference grid
// for intraday support/resistance — on daily data these represent prior-day levels.
// ─────────────────────────────────────────────────────────────────────────────
function pivotPoints(prevHigh, prevLow, prevClose) {
  if (prevHigh == null || prevLow == null || prevClose == null) return null;
  const pivot = (prevHigh + prevLow + prevClose) / 3;
  return {
    pivot: Math.round(pivot * 100) / 100,
    r1:    Math.round((2 * pivot - prevLow) * 100) / 100,
    r2:    Math.round((pivot + (prevHigh - prevLow)) * 100) / 100,
    r3:    Math.round((prevHigh + 2 * (pivot - prevLow)) * 100) / 100,
    s1:    Math.round((2 * pivot - prevHigh) * 100) / 100,
    s2:    Math.round((pivot - (prevHigh - prevLow)) * 100) / 100,
    s3:    Math.round((prevLow - 2 * (prevHigh - pivot)) * 100) / 100,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOMENTUM REGIME CLASSIFICATION
// Combines multiple momentum reads into a single regime label.
// Avoids single-indicator noise by requiring confluence.
// ─────────────────────────────────────────────────────────────────────────────
function classifyMomentumRegime({ rsiVal, macdHist, adxVal, plusDI, minusDI, rocVal, cmoVal }) {
  let bullVotes = 0, bearVotes = 0;
  if (rsiVal != null) {
    if (rsiVal > 55)      bullVotes++;
    else if (rsiVal < 45) bearVotes++;
  }
  if (macdHist != null) {
    if (macdHist > 0) bullVotes++;
    else              bearVotes++;
  }
  if (adxVal != null && adxVal >= 20) {
    // Only count ADX direction when trend is meaningful
    if (plusDI != null && minusDI != null) {
      if (plusDI > minusDI) bullVotes++;
      else                  bearVotes++;
    }
  }
  if (rocVal != null) {
    if (rocVal > 0) bullVotes++;
    else            bearVotes++;
  }
  if (cmoVal != null) {
    if (cmoVal > 10)       bullVotes++;
    else if (cmoVal < -10) bearVotes++;
  }
  const total = bullVotes + bearVotes;
  if (total === 0) return { regime: 'neutral', bullVotes: 0, bearVotes: 0, strength: 0 };
  const strength = Math.round((Math.max(bullVotes, bearVotes) / total) * 100);
  let regime = 'neutral';
  if (bullVotes >= 4)      regime = 'strong_bull';
  else if (bullVotes >= 3) regime = 'bull';
  else if (bearVotes >= 4) regime = 'strong_bear';
  else if (bearVotes >= 3) regime = 'bear';
  else                     regime = 'neutral';
  return { regime, bullVotes, bearVotes, strength };
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL INDICATOR SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────
function computeIndicators(closes, volumes = [], highs = null, lows = null) {
  if (!closes || closes.length < 2) return null;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsiSeries = rsi(closes, 14);
  const macdRes   = macd(closes);
  const boll      = bollinger(closes, 20, 2);
  const rocSeries = roc(closes, 10);
  const cmoSeries = cmo(closes, 14);

  const latestClose    = last(closes);
  const latestSma20    = last(sma20);
  const latestSma50    = last(sma50);
  const latestSma200   = last(sma200);
  const latestRsi      = last(rsiSeries);
  const latestHist     = last(macdRes.hist);
  const latestMacdLine = last(macdRes.macdLine);
  const latestSignal   = last(macdRes.signalLine);
  const latestBollUpper = last(boll.upper);
  const latestBollLower = last(boll.lower);
  const latestBollWidth = last(boll.width);
  const latestBollSqueeze = last(boll.squeeze);
  const latestRoc      = last(rocSeries);
  const latestCmo      = last(cmoSeries);

  let bollPosition = null;
  if (latestBollUpper != null && latestBollLower != null) {
    if (latestClose >= latestBollUpper)      bollPosition = 'at_or_above_upper';
    else if (latestClose <= latestBollLower) bollPosition = 'at_or_below_lower';
    else                                     bollPosition = 'inside_bands';
  }

  const hasOhlc = Array.isArray(highs) && Array.isArray(lows)
    && highs.length === closes.length && lows.length === closes.length
    && highs.some(v => v != null) && lows.some(v => v != null);

  let latestAtr = null, latestStochK = null, latestStochD = null, stochZone = 'unknown';
  let adxRes = { adx: [], plusDI: [], minusDI: [] };
  let cciSeries = [], willRSeries = [];
  let ichi = null, volRegime = null;
  let mfiSeries = [];
  let latestBullPower = null, latestBearPower = null;
  let supertrendData = { direction: [], line: [] };
  let psarData = { sar: [], trend: [] };
  let aroonData = { up: [], down: [], osc: [] };
  let keltnerData = { basis: [], upper: [], lower: [] };

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
    adxRes      = adx(highs, lows, closes, 14);
    cciSeries   = cci(highs, lows, closes, 20);
    willRSeries = williamsR(highs, lows, closes, 14);
    ichi        = ichimoku(highs, lows, closes);
    mfiSeries   = mfi(highs, lows, closes, volumes, 14);
    const elder = elderRay(highs, lows, closes, 13);
    latestBullPower = last(elder.bullPower);
    latestBearPower = last(elder.bearPower);
    supertrendData  = supertrend(highs, lows, closes, 10, 3);
    psarData        = psar(highs, lows);
    aroonData       = aroon(highs, lows, 25);
    keltnerData     = keltner(closes, highs, lows, 20, 1.5);
  }

  const latestAdx      = last(adxRes.adx);
  const latestPlusDI   = last(adxRes.plusDI);
  const latestMinusDI  = last(adxRes.minusDI);
  const latestCci      = last(cciSeries);
  const latestWillR    = last(willRSeries);
  const latestMfi      = last(mfiSeries);
  const latestSTDir    = last(supertrendData.direction);
  const latestSTLine   = last(supertrendData.line);
  const latestPsarTrend = last(psarData.trend);
  const latestPsarVal  = last(psarData.sar);
  const latestAroonOsc = last(aroonData.osc);
  const latestKeltUpper = last(keltnerData.upper);
  const latestKeltLower = last(keltnerData.lower);

  let trend = 'neutral';
  if (latestSma20 != null && latestSma50 != null) {
    trend = latestSma20 > latestSma50 ? 'bullish' : latestSma20 < latestSma50 ? 'bearish' : 'neutral';
  }

  // 200 SMA position — major trend context
  let longTrend = 'unknown';
  if (latestSma200 != null && latestClose != null) {
    longTrend = latestClose > latestSma200 ? 'above_200sma' : 'below_200sma';
  }

  let volumeSpike = null;
  if (volumes && volumes.length >= 5) {
    const recent = volumes[volumes.length - 1];
    const priorWindow = volumes.slice(-21, -1).filter(v => v != null && v > 0);
    if (priorWindow.length) {
      const avg = priorWindow.reduce((a, b) => a + b, 0) / priorWindow.length;
      volumeSpike = {
        current: recent, avg,
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
      obvTrend = recent[recent.length - 1] > recent[0] ? 'rising' : recent[recent.length - 1] < recent[0] ? 'falling' : 'flat';
    }
  }

  const vwapSeries = volumes && volumes.length === closes.length
    ? rollingVwap(closes, volumes, highs, lows, 20) : null;
  const latestVwap = vwapSeries ? last(vwapSeries) : null;

  const fib = fibonacciLevels(closes, hasOhlc ? highs : null, hasOhlc ? lows : null, 90);

  // Pivot points from last 3 bars' H/L/C
  let pivots = null;
  if (hasOhlc && closes.length >= 2) {
    const li = closes.length - 2; // previous bar
    pivots = pivotPoints(highs[li], lows[li], closes[li]);
  }

  // Divergence detection
  const divergence = detectDivergence(closes, rsiSeries, macdRes.hist);

  // Momentum regime
  const momentumRegime = classifyMomentumRegime({
    rsiVal: latestRsi, macdHist: latestHist,
    adxVal: latestAdx, plusDI: latestPlusDI, minusDI: latestMinusDI,
    rocVal: latestRoc, cmoVal: latestCmo,
  });

  // Squeeze confluence: Bollinger squeeze + Keltner — true squeeze when BB inside KC
  let isSqueeze = latestBollSqueeze ?? false;
  if (latestBollUpper != null && latestBollLower != null && latestKeltUpper != null && latestKeltLower != null) {
    isSqueeze = latestBollLower > latestKeltLower && latestBollUpper < latestKeltUpper;
  }

  const confluence = computeConfluence({
    trend, latestRsi, latestHist, volumeSpike, bollPosition, latestStochK, stochZone,
    obvTrend, latestAdx, latestPlusDI, latestMinusDI, latestCci, latestWillR, ichi,
    latestClose, latestVwap, latestMfi, latestSTDir, latestPsarTrend, latestAroonOsc,
    latestBullPower, latestBearPower, longTrend, latestRoc, latestCmo,
  });

  return {
    close:  latestClose,
    sma20:  latestSma20,
    sma50:  latestSma50,
    sma200: latestSma200 != null ? Math.round(latestSma200 * 100) / 100 : null,
    longTrend,
    smaTrend: trend,
    rsi:     latestRsi != null ? Math.round(latestRsi * 10) / 10 : null,
    rsiZone: rsiZone(latestRsi),
    macdHistogram: latestHist != null ? Math.round(latestHist * 10000) / 10000 : null,
    macdLine: latestMacdLine != null ? Math.round(latestMacdLine * 10000) / 10000 : null,
    macdSignal: latestSignal != null ? Math.round(latestSignal * 10000) / 10000 : null,
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
      strength: latestAdx >= 40 ? 'strong_trend' : latestAdx >= 25 ? 'trending' : latestAdx >= 20 ? 'developing' : 'range_bound',
    } : null,
    cci: latestCci != null ? Math.round(latestCci * 10) / 10 : null,
    williamsR: latestWillR != null ? Math.round(latestWillR * 10) / 10 : null,
    mfi: latestMfi != null ? Math.round(latestMfi * 10) / 10 : null,
    roc: latestRoc != null ? Math.round(latestRoc * 100) / 100 : null,
    cmo: latestCmo != null ? Math.round(latestCmo * 10) / 10 : null,
    ichimoku: ichi,
    fibonacci: fib,
    pivotPoints: pivots,
    supertrend: latestSTDir != null ? {
      direction: latestSTDir === 1 ? 'up' : 'down',
      line: latestSTLine != null ? Math.round(latestSTLine * 100) / 100 : null,
    } : null,
    psar: latestPsarTrend != null ? {
      trend: latestPsarTrend === 1 ? 'up' : 'down',
      value: latestPsarVal != null ? Math.round(latestPsarVal * 100) / 100 : null,
    } : null,
    aroon: latestAroonOsc != null ? {
      oscillator: Math.round(latestAroonOsc * 10) / 10,
      bias: latestAroonOsc >= 50 ? 'strong_bull' : latestAroonOsc >= 20 ? 'bull' : latestAroonOsc <= -50 ? 'strong_bear' : latestAroonOsc <= -20 ? 'bear' : 'neutral',
    } : null,
    elderRay: latestBullPower != null ? {
      bullPower: Math.round(latestBullPower * 100) / 100,
      bearPower: Math.round(latestBearPower * 100) / 100,
      // Both positive = strong bulls; both negative = strong bears
      signal: latestBullPower > 0 && latestBearPower > 0 ? 'strong_bull'
            : latestBullPower < 0 && latestBearPower < 0 ? 'strong_bear'
            : latestBullPower > 0 && latestBearPower < 0 ? 'bull_pullback'
            : 'bear_rally',
    } : null,
    keltner: latestKeltUpper != null ? {
      upper: Math.round(latestKeltUpper * 100) / 100,
      lower: Math.round(latestKeltLower * 100) / 100,
      squeeze: isSqueeze,
    } : null,
    divergence,
    momentumRegime,
    volatilityRegime: volRegime,
    confluence,
    sparkline: closes.slice(-30),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFLUENCE TALLY
// Corrected lean directions:
//  - RSI overbought → DOWN (stretched high, less room above)
//  - RSI oversold   → UP
//  - Same logic for Stochastic, CCI, Williams %R, MFI
//  - Bollinger at upper → DOWN (mean-reversion pressure)
//  - Bollinger at lower → UP
//  - Supertrend up direction → UP
//  - PSAR below price (trend = up) → UP
//  - Aroon oscillator > 50 → UP, < -50 → DOWN
//  - Elder Ray: bullPower positive + bearPower negative → bull pullback (UP)
//  - Price above 200 SMA → UP (major trend context)
// ─────────────────────────────────────────────────────────────────────────────
function computeConfluence({
  trend, latestRsi, latestHist, volumeSpike, bollPosition, latestStochK, stochZone,
  obvTrend, latestAdx, latestPlusDI, latestMinusDI, latestCci, latestWillR, ichi,
  latestClose, latestVwap, latestMfi, latestSTDir, latestPsarTrend, latestAroonOsc,
  latestBullPower, latestBearPower, longTrend, latestRoc, latestCmo,
}) {
  const readings = [];

  // 200 SMA — major trend context
  if (longTrend && longTrend !== 'unknown') {
    readings.push({
      indicator: 'sma200',
      detail: longTrend === 'above_200sma' ? 'Price above 200-day SMA (long-term bullish context)' : 'Price below 200-day SMA (long-term bearish context)',
      lean: longTrend === 'above_200sma' ? 'up' : 'down',
    });
  }

  // SMA20/50 trend
  readings.push({
    indicator: 'sma_trend',
    detail: trend === 'bullish' ? 'SMA20 above SMA50' : trend === 'bearish' ? 'SMA20 below SMA50' : 'SMA20/50 flat',
    lean: trend === 'bullish' ? 'up' : trend === 'bearish' ? 'down' : 'flat',
  });

  // Supertrend
  if (latestSTDir != null) {
    readings.push({
      indicator: 'supertrend',
      detail: latestSTDir === 1 ? 'Supertrend: uptrend (price above trailing stop)' : 'Supertrend: downtrend (price below trailing stop)',
      lean: latestSTDir === 1 ? 'up' : 'down',
    });
  }

  // PSAR
  if (latestPsarTrend != null) {
    readings.push({
      indicator: 'psar',
      detail: latestPsarTrend === 1 ? 'PSAR below price (bullish)' : 'PSAR above price (bearish)',
      lean: latestPsarTrend === 1 ? 'up' : 'down',
    });
  }

  // RSI — overbought leans DOWN
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

  // CMO
  if (latestCmo != null) {
    readings.push({
      indicator: 'cmo',
      detail: `CMO ${Math.round(latestCmo * 10) / 10}`,
      lean: latestCmo > 10 ? 'up' : latestCmo < -10 ? 'down' : 'flat',
    });
  }

  // ROC
  if (latestRoc != null) {
    readings.push({
      indicator: 'roc',
      detail: `ROC(10) ${latestRoc > 0 ? '+' : ''}${Math.round(latestRoc * 100) / 100}%`,
      lean: latestRoc > 0 ? 'up' : latestRoc < 0 ? 'down' : 'flat',
    });
  }

  // MACD histogram
  if (latestHist != null) {
    readings.push({
      indicator: 'macd_histogram',
      detail: `MACD histogram ${latestHist > 0 ? 'positive' : latestHist < 0 ? 'negative' : 'flat'} (${Math.round(latestHist * 10000) / 10000})`,
      lean: latestHist > 0 ? 'up' : latestHist < 0 ? 'down' : 'flat',
    });
  } else {
    readings.push({ indicator: 'macd_histogram', detail: 'not enough history', lean: 'flat' });
  }

  // Bollinger — at upper = mean reversion pressure (down)
  if (bollPosition) {
    readings.push({
      indicator: 'bollinger',
      detail: bollPosition === 'at_or_above_upper' ? 'Price at/above upper band'
            : bollPosition === 'at_or_below_lower' ? 'Price at/below lower band'
            : 'Price inside the bands',
      lean: bollPosition === 'at_or_above_upper' ? 'down' : bollPosition === 'at_or_below_lower' ? 'up' : 'flat',
    });
  }

  // Stochastic — overbought leans DOWN
  if (latestStochK != null) {
    readings.push({
      indicator: 'stochastic',
      detail: `Stoch %K ${Math.round(latestStochK * 10) / 10} (${stochZone})`,
      lean: stochZone === 'overbought' ? 'down' : stochZone === 'oversold' ? 'up' : 'flat',
    });
  }

  // MFI — volume-weighted RSI; overbought leans DOWN
  if (latestMfi != null) {
    const mfiZone = latestMfi >= 80 ? 'overbought' : latestMfi <= 20 ? 'oversold' : 'neutral';
    readings.push({
      indicator: 'mfi',
      detail: `MFI ${Math.round(latestMfi * 10) / 10} (${mfiZone})`,
      lean: mfiZone === 'overbought' ? 'down' : mfiZone === 'oversold' ? 'up' : 'flat',
    });
  }

  // Volume — always flat (no directional info in volume alone)
  if (volumeSpike) {
    readings.push({
      indicator: 'volume',
      detail: volumeSpike.isSpike
        ? `Volume ${volumeSpike.ratio?.toFixed(1)}x average (elevated activity, direction unknown)`
        : 'Volume near average',
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

  // ADX: directional only when >= 20
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

  // Aroon oscillator
  if (latestAroonOsc != null) {
    readings.push({
      indicator: 'aroon',
      detail: `Aroon oscillator ${Math.round(latestAroonOsc * 10) / 10}`,
      lean: latestAroonOsc >= 20 ? 'up' : latestAroonOsc <= -20 ? 'down' : 'flat',
    });
  }

  // CCI — overbought leans DOWN
  if (latestCci != null) {
    const zone = latestCci >= 100 ? 'overbought' : latestCci <= -100 ? 'oversold' : 'neutral';
    readings.push({
      indicator: 'cci',
      detail: `CCI ${Math.round(latestCci * 10) / 10} (${zone})`,
      lean: zone === 'overbought' ? 'down' : zone === 'oversold' ? 'up' : 'flat',
    });
  }

  // Williams %R — overbought (>= -20) leans DOWN
  if (latestWillR != null) {
    const zone = latestWillR >= -20 ? 'overbought' : latestWillR <= -80 ? 'oversold' : 'neutral';
    readings.push({
      indicator: 'williams_r',
      detail: `Williams %R ${Math.round(latestWillR * 10) / 10} (${zone})`,
      lean: zone === 'overbought' ? 'down' : zone === 'oversold' ? 'up' : 'flat',
    });
  }

  // Elder Ray
  if (latestBullPower != null && latestBearPower != null) {
    const erSignal = latestBullPower > 0 && latestBearPower < 0 ? 'up'   // classic bull
                   : latestBullPower < 0 && latestBearPower > 0 ? 'down' // classic bear
                   : latestBullPower > 0 && latestBearPower > 0 ? 'up'   // strong bull
                   : 'down'; // both negative
    readings.push({
      indicator: 'elder_ray',
      detail: `Elder Ray: Bull power ${latestBullPower > 0 ? '+' : ''}${Math.round(latestBullPower * 100) / 100}, Bear power ${latestBearPower > 0 ? '+' : ''}${Math.round(latestBearPower * 100) / 100}`,
      lean: erSignal,
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

  // VWAP position
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
  sma, ema, dema, tema, rsi, macd, bollinger, keltner, atr, stochastic,
  obv, mfi, roc, cmo, aroon, psar, supertrend, elderRay,
  rollingVwap, adx, cci, williamsR, ichimoku, fibonacciLevels,
  atrPercentileRegime, pivotPoints, detectDivergence, classifyMomentumRegime,
  computeIndicators, computeConfluence, rsiZone,
};
