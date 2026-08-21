// A rules engine the USER defines and drives. Nothing in here proposes a
// rule, weights one over another, or tells you which condition to use — it
// takes condition(s) you wrote, checks every day in the asset's available
// history where they were true, and reports what price actually did over
// the following N days. That's a historical frequency table, not a signal:
// past hit-rate on a few months of free daily data is a thin sample, says
// nothing about tomorrow, and is shown with that caveat attached.
//
// Two additions over a plain in-sample backtest:
// 1. Condition GROUPS — groups are OR'd together, conditions within a group
//    are AND'd. This lets you express "(RSI<30) OR (Stoch%K<20)" instead of
//    only ever needing every condition to fire simultaneously.
// 2. Walk-forward validation — instead of one hit-rate over the whole
//    history (which can overfit to a single lucky/unlucky stretch), the
//    history is split into sequential folds; the rule's hit-rate is
//    computed independently on each fold so you can see whether the edge
//    (if any) is consistent over time or was concentrated in one period.
//    This is still descriptive history, not a guarantee of future folds.

const { sma, rsi, macd, bollinger, atr, stochastic, obv, adx, cci, williamsR } = require('./indicators');

const METRICS = [
  'rsi', 'sma20', 'sma50', 'macd_hist', 'boll_upper', 'boll_lower', 'close',
  'stoch_k', 'adx', 'plus_di', 'minus_di', 'cci', 'williams_r', 'obv',
];
const OPERATORS = ['gt', 'lt', 'gte', 'lte', 'crosses_above', 'crosses_below'];

function computeSeries(closes, highs, lows, volumes) {
  const rsiSeries = rsi(closes, 14);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const macdRes = macd(closes);
  const boll = bollinger(closes, 20, 2);
  const hasOhlc = Array.isArray(highs) && Array.isArray(lows) && highs.length === closes.length && lows.length === closes.length;
  const stoch = hasOhlc ? stochastic(highs, lows, closes) : { k: closes.map(() => null) };
  const adxRes = hasOhlc ? adx(highs, lows, closes, 14) : { adx: closes.map(() => null), plusDI: closes.map(() => null), minusDI: closes.map(() => null) };
  const cciSeries = hasOhlc ? cci(highs, lows, closes, 20) : closes.map(() => null);
  const willRSeries = hasOhlc ? williamsR(highs, lows, closes, 14) : closes.map(() => null);
  const obvSeries = Array.isArray(volumes) && volumes.length === closes.length ? obv(closes, volumes) : closes.map(() => null);
  return {
    close: closes,
    rsi: rsiSeries,
    sma20,
    sma50,
    macd_hist: macdRes.hist,
    boll_upper: boll.upper,
    boll_lower: boll.lower,
    stoch_k: stoch.k,
    adx: adxRes.adx,
    plus_di: adxRes.plusDI,
    minus_di: adxRes.minusDI,
    cci: cciSeries,
    williams_r: willRSeries,
    obv: obvSeries,
  };
}

function checkCondition(series, cond, i) {
  const val = series[cond.metric] ? series[cond.metric][i] : null;
  if (val == null) return false;
  const threshold = Number(cond.value);
  if (!Number.isFinite(threshold) && !['crosses_above', 'crosses_below'].includes(cond.operator)) return false;

  switch (cond.operator) {
    case 'gt': return val > threshold;
    case 'gte': return val >= threshold;
    case 'lt': return val < threshold;
    case 'lte': return val <= threshold;
    case 'crosses_above': {
      const prev = series[cond.metric][i - 1];
      return prev != null && prev <= threshold && val > threshold;
    }
    case 'crosses_below': {
      const prev = series[cond.metric][i - 1];
      return prev != null && prev >= threshold && val < threshold;
    }
    default: return false;
  }
}

// `groups` is an array of arrays: outer array is OR'd, each inner array's
// conditions are AND'd. Accepts a flat `conditions` array too (back-compat
// with the original single-group shape) by wrapping it as one group.
function normalizeGroups(conditions, groups) {
  if (Array.isArray(groups) && groups.length) return groups;
  if (Array.isArray(conditions) && conditions.length) return [conditions];
  return [];
}

function fireIndex(series, groups, i) {
  return groups.some((group) => group.every((c) => checkCondition(series, c, i)));
}

function validateGroups(groups) {
  const errors = [];
  if (!groups.length) errors.push('At least one condition (or condition group) is required.');
  for (const group of groups) {
    if (!Array.isArray(group) || !group.length) { errors.push('Each group needs at least one condition.'); continue; }
    for (const c of group) {
      if (!METRICS.includes(c.metric)) errors.push(`Unknown metric: ${c.metric}`);
      if (!OPERATORS.includes(c.operator)) errors.push(`Unknown operator: ${c.operator}`);
    }
  }
  return errors;
}

function summarizeFires(fires) {
  const up = fires.filter((f) => f.direction === 'up').length;
  const down = fires.filter((f) => f.direction === 'down').length;
  const flat = fires.length - up - down;
  const avgPctChange = fires.length ? fires.reduce((a, f) => a + f.pctChange, 0) / fires.length : null;
  return {
    sampleSize: fires.length,
    up, down, flat,
    upRate: fires.length ? Math.round((up / fires.length) * 1000) / 10 : null,
    downRate: fires.length ? Math.round((down / fires.length) * 1000) / 10 : null,
    avgPctChange: avgPctChange != null ? Math.round(avgPctChange * 100) / 100 : null,
  };
}

function runFires(closes, series, groups, horizonDays, rangeStart, rangeEnd) {
  const fires = [];
  const end = Math.min(rangeEnd, closes.length - horizonDays);
  for (let i = rangeStart; i < end; i++) {
    if (!fireIndex(series, groups, i)) continue;
    const startPrice = closes[i];
    const endPrice = closes[i + horizonDays];
    const pctChange = ((endPrice - startPrice) / startPrice) * 100;
    fires.push({ index: i, pctChange, direction: pctChange > 0 ? 'up' : pctChange < 0 ? 'down' : 'flat' });
  }
  return fires;
}

/**
 * Backtests a user-supplied rule against the given closing-price history.
 * `conditions` (flat, AND-only) or `groups` (OR of AND-groups) — pass
 * either. For every historical day the rule fired, looks `horizonDays`
 * ahead and records whether price was higher, lower, or unchanged.
 *
 * When `walkForward` is true (default), the history is also split into
 * sequential folds (default 4) and the same hit-rate is computed
 * independently per fold, so you can see whether results were consistent
 * across time or concentrated in one stretch — still descriptive frequency
 * stats, not a probability of what happens next.
 */
function backtestRule({ closes, highs, lows, volumes, conditions, groups, horizonDays = 5, walkForward = true, folds = 4 }) {
  const normGroups = normalizeGroups(conditions, groups);
  const groupErrors = validateGroups(normGroups);
  if (groupErrors.length) return { ok: false, reason: groupErrors[0], errors: groupErrors };
  if (!closes || closes.length < 30) {
    return { ok: false, reason: 'Not enough price history to backtest (need at least 30 data points).' };
  }

  const series = computeSeries(closes, highs, lows, volumes);
  const usableEnd = closes.length - horizonDays;
  const fires = runFires(closes, series, normGroups, horizonDays, 0, usableEnd);
  const overall = summarizeFires(fires);

  let walkForwardResult = null;
  if (walkForward && usableEnd > 0) {
    const foldCount = Math.max(2, Math.min(folds, Math.floor(usableEnd / 15) || 2));
    const foldSize = Math.floor(usableEnd / foldCount);
    const foldResults = [];
    for (let f = 0; f < foldCount; f++) {
      const start = f * foldSize;
      const end = f === foldCount - 1 ? usableEnd : start + foldSize;
      if (end <= start) continue;
      const foldFires = runFires(closes, series, normGroups, horizonDays, start, end);
      foldResults.push({ fold: f + 1, ...summarizeFires(foldFires) });
    }
    const foldsWithData = foldResults.filter((f) => f.sampleSize > 0);
    const upRates = foldsWithData.map((f) => f.upRate).filter((v) => v != null);
    const consistency = upRates.length >= 2
      ? Math.round((Math.max(...upRates) - Math.min(...upRates)) * 10) / 10
      : null;
    walkForwardResult = {
      folds: foldResults,
      // Spread between the best and worst fold's up-rate. A small spread
      // means the historical tendency held up similarly across different
      // stretches of time; a large spread means it was concentrated in one
      // period — a strong reason to distrust the overall number.
      upRateSpread: consistency,
      note: consistency == null
        ? 'Not enough fires per fold to assess consistency.'
        : consistency <= 15
          ? 'Hit-rate was reasonably consistent across time periods.'
          : 'Hit-rate varied a lot between time periods — the overall number may be driven by one stretch, not a durable pattern.',
    };
  }

  return {
    ok: true,
    conditions: normGroups.length === 1 ? normGroups[0] : undefined,
    groups: normGroups.length > 1 ? normGroups : undefined,
    horizonDays,
    historyLength: closes.length,
    ...overall,
    walkForward: walkForwardResult,
    caveat: overall.sampleSize < 10
      ? 'Fewer than 10 historical occurrences — far too small a sample to draw any conclusion from.'
      : 'Historical frequency only, on a limited free-data window. Not a probability of what happens next, and market conditions change.',
  };
}

module.exports = { backtestRule, METRICS, OPERATORS };
