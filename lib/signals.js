const db = require('./db');

/**
 * Compares a fresh indicator snapshot against the last one stored for this
 * symbol and returns zero or more "alert" objects for anything that just
 * changed state (not for conditions that were already true last poll — that
 * would just spam the same alert every cycle).
 *
 * IMPORTANT: these are descriptive statements about the indicator itself
 * ("RSI crossed above 70", "SMA20 crossed above SMA50"), not trading advice.
 * Every alert carries a `note` reiterating that. There is no accuracy
 * guarantee — these are lagging, rule-based observations on delayed data.
 */
function detectAlerts(symbol, snapshot) {
  const prev = db.getLastIndicatorState(symbol);
  const alerts = [];
  const now = new Date().toISOString();

  if (prev) {
    // RSI zone change
    if (prev.rsiZone !== snapshot.rsiZone && snapshot.rsiZone !== 'neutral' && snapshot.rsiZone !== 'unknown') {
      alerts.push({
        id: `${symbol}-rsi-${now}`,
        symbol,
        type: 'rsi',
        label: snapshot.rsiZone === 'overbought' ? `${symbol} RSI entered overbought (${snapshot.rsi})` : `${symbol} RSI entered oversold (${snapshot.rsi})`,
        note: 'Indicator reading only — RSI extremes can persist for a long time and are not a timing signal on their own.',
        at: now,
      });
    }
    // SMA20/50 crossover ("golden cross" / "death cross" style, but daily-granularity, not intraday)
    if (prev.smaTrend !== snapshot.smaTrend && snapshot.smaTrend !== 'neutral' && prev.smaTrend !== 'neutral') {
      alerts.push({
        id: `${symbol}-sma-${now}`,
        symbol,
        type: 'sma_cross',
        label: snapshot.smaTrend === 'bullish' ? `${symbol} 20-day average crossed above the 50-day` : `${symbol} 20-day average crossed below the 50-day`,
        note: 'A lagging trend indicator, not a prediction — moving-average crossovers confirm a trend after it has already started.',
        at: now,
      });
    }
    // Volume spike newly triggered
    if (snapshot.volumeSpike && snapshot.volumeSpike.isSpike && !(prev.volumeSpike && prev.volumeSpike.isSpike)) {
      alerts.push({
        id: `${symbol}-vol-${now}`,
        symbol,
        type: 'volume_spike',
        label: `${symbol} volume is ${snapshot.volumeSpike.ratio.toFixed(1)}x its recent average`,
        note: 'Unusual volume often precedes or accompanies news — check the news feed for context, this alone doesn\'t say which direction.',
        at: now,
      });
    }
  }

  db.setLastIndicatorState(symbol, { rsiZone: snapshot.rsiZone, smaTrend: snapshot.smaTrend, volumeSpike: snapshot.volumeSpike });
  return alerts;
}

module.exports = { detectAlerts };
