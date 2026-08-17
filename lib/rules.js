// A rules engine the USER defines and drives. Nothing in here proposes a
// rule, weights one over another, or tells you which condition to use — it
// takes a condition you wrote, checks every day in the asset's available
// history where that condition was true, and reports what price actually
// did over the following N days. That's a historical frequency table, not
// a signal: past hit-rate on ~90 days of free daily data is a thin sample,
// says nothing about tomorrow, and is shown with that caveat attached.

const { sma, rsi, macd, bollinger, atr, stochastic } = require('./indicators');

const METRICS = ['rsi', 'sma20', 'sma50', 'macd_hist', 'boll_upper', 'boll_lower', 'close', 'stoch_k'];
const OPERATORS = ['gt', 'lt', 'gte', 'lte', 'crosses_above', 'crosses_below'];

function computeSeries(closes, highs, lows) {
  const rsiSeries = rsi(closes, 14);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const macdRes = macd(closes);
  const boll = bollinger(closes, 20, 2);
  const hasOhlc = Array.isArray(highs) && Array.isArray(lows) && highs.length === closes.length && lows.length === closes.length;
  const stoch = hasOhlc ? stochastic(highs, lows, closes) : { k: closes.map(() => null) };
  return {
    close: closes,
    rsi: rsiSeries,
    sma20,
    sma50,
    macd_hist: macdRes.hist,
    boll_upper: boll.upper,
    boll_lower: boll.lower,
    stoch_k: stoch.k,
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

/**
 * Backtests a user-supplied rule (a list of conditions, all must hold —
 * AND only, kept simple and auditable) against the given closing-price
 * history. For every historical day the rule fired, looks `horizonDays`
 * ahead and records whether price was higher, lower, or unchanged.
 *
 * Returns counts and hit-rates — descriptive frequency stats about what
 * happened after this exact rule fired in this exact (short, free-tier)
 * history. Explicitly NOT a probability of what happens next time; small
 * samples on ~90 days of data can look decisive and still be noise.
 */
function backtestRule({ closes, highs, lows, conditions, horizonDays = 5 }) {
  if (!Array.isArray(conditions) || !conditions.length) {
    return { ok: false, reason: 'At least one condition is required.' };
  }
  for (const c of conditions) {
    if (!METRICS.includes(c.metric)) return { ok: false, reason: `Unknown metric: ${c.metric}` };
    if (!OPERATORS.includes(c.operator)) return { ok: false, reason: `Unknown operator: ${c.operator}` };
  }
  if (!closes || closes.length < 30) {
    return { ok: false, reason: 'Not enough price history to backtest (need at least 30 data points).' };
  }

  const series = computeSeries(closes, highs, lows);
  const fires = [];
  for (let i = 0; i < closes.length - horizonDays; i++) {
    const allMatch = conditions.every((c) => checkCondition(series, c, i));
    if (!allMatch) continue;
    const startPrice = closes[i];
    const endPrice = closes[i + horizonDays];
    const pctChange = ((endPrice - startPrice) / startPrice) * 100;
    fires.push({ index: i, pctChange, direction: pctChange > 0 ? 'up' : pctChange < 0 ? 'down' : 'flat' });
  }

  const up = fires.filter((f) => f.direction === 'up').length;
  const down = fires.filter((f) => f.direction === 'down').length;
  const flat = fires.length - up - down;
  const avgPctChange = fires.length ? fires.reduce((a, f) => a + f.pctChange, 0) / fires.length : null;

  return {
    ok: true,
    conditions,
    horizonDays,
    sampleSize: fires.length,
    historyLength: closes.length,
    up,
    down,
    flat,
    upRate: fires.length ? Math.round((up / fires.length) * 1000) / 10 : null,
    downRate: fires.length ? Math.round((down / fires.length) * 1000) / 10 : null,
    avgPctChange: avgPctChange != null ? Math.round(avgPctChange * 100) / 100 : null,
    caveat: fires.length < 10
      ? 'Fewer than 10 historical occurrences — far too small a sample to draw any conclusion from.'
      : 'Historical frequency only, on a short (~90 day) free-data window. Not a probability of what happens next, and market conditions change.',
  };
}

module.exports = { backtestRule, METRICS, OPERATORS };
