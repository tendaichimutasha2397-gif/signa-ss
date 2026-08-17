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
    // RSI zone change — severity reflects how far past the 70/30 line the
    // reading is, purely descriptive of magnitude, not urgency to act.
    if (prev.rsiZone !== snapshot.rsiZone && snapshot.rsiZone !== 'neutral' && snapshot.rsiZone !== 'unknown') {
      const dist = snapshot.rsiZone === 'overbought' ? snapshot.rsi - 70 : 30 - snapshot.rsi;
      const severity = dist >= 10 ? 'strong' : 'mild';
      alerts.push({
        id: `${symbol}-rsi-${now}`,
        symbol,
        type: 'rsi',
        severity,
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
        severity: 'strong', // crossovers are inherently the rarer, larger-context event
        label: snapshot.smaTrend === 'bullish' ? `${symbol} 20-day average crossed above the 50-day` : `${symbol} 20-day average crossed below the 50-day`,
        note: 'A lagging trend indicator, not a prediction — moving-average crossovers confirm a trend after it has already started.',
        at: now,
      });
    }
    // Volume spike newly triggered — severity reflects how far above 2x it is.
    if (snapshot.volumeSpike && snapshot.volumeSpike.isSpike && !(prev.volumeSpike && prev.volumeSpike.isSpike)) {
      const severity = snapshot.volumeSpike.ratio >= 4 ? 'strong' : 'mild';
      alerts.push({
        id: `${symbol}-vol-${now}`,
        symbol,
        type: 'volume_spike',
        severity,
        label: `${symbol} volume is ${snapshot.volumeSpike.ratio.toFixed(1)}x its recent average`,
        note: 'Unusual volume often precedes or accompanies news — check the news feed for context, this alone doesn\'t say which direction.',
        at: now,
      });
    }
    // MACD histogram sign flip — a fresh momentum-direction change, distinct
    // from the slower SMA crossover above.
    const curMacdSign = snapshot.macdHistogram == null ? null : Math.sign(snapshot.macdHistogram);
    if (prev.macdSign != null && curMacdSign != null && prev.macdSign !== curMacdSign && curMacdSign !== 0) {
      alerts.push({
        id: `${symbol}-macd-${now}`,
        symbol,
        type: 'macd_flip',
        severity: 'mild',
        label: curMacdSign > 0 ? `${symbol} MACD histogram turned positive` : `${symbol} MACD histogram turned negative`,
        note: 'A momentum reading, not a prediction — histogram sign flips are frequent and many do not lead to a sustained move.',
        at: now,
      });
    }
  }

  const macdSign = snapshot.macdHistogram == null ? null : Math.sign(snapshot.macdHistogram);
  db.setLastIndicatorState(symbol, { rsiZone: snapshot.rsiZone, smaTrend: snapshot.smaTrend, volumeSpike: snapshot.volumeSpike, macdSign });
  return alerts;
}

module.exports = { detectAlerts };
