'use strict';

const db = require('./db');

/**
 * Compares a fresh indicator snapshot against the last stored one and emits
 * alert objects only for conditions that CHANGED state this poll — not for
 * conditions that were already true last cycle (which would spam the same
 * alert every 2 minutes).
 *
 * Alerts are descriptive statements about indicator behaviour, not trade
 * recommendations. Every alert carries a `note` reiterating that.
 */
function detectAlerts(symbol, snapshot) {
  const prev  = db.getLastIndicatorState(symbol);
  const alerts = [];
  const now   = new Date().toISOString();

  if (prev) {
    // RSI zone change — only alert when entering overbought/oversold from neutral
    if (prev.rsiZone !== snapshot.rsiZone
        && snapshot.rsiZone !== 'neutral'
        && snapshot.rsiZone !== 'unknown') {
      const dist = snapshot.rsiZone === 'overbought' ? snapshot.rsi - 70 : 30 - snapshot.rsi;
      alerts.push({
        id: `${symbol}-rsi-${now}`,
        symbol,
        type: 'rsi',
        severity: dist >= 10 ? 'strong' : 'mild',
        label: snapshot.rsiZone === 'overbought'
          ? `${symbol} RSI entered overbought (${snapshot.rsi})`
          : `${symbol} RSI entered oversold (${snapshot.rsi})`,
        note: 'Indicator reading only — RSI extremes can persist for extended periods and are not a timing signal on their own.',
        at: now,
      });
    }

    // SMA20/50 crossover
    if (prev.smaTrend !== snapshot.smaTrend
        && snapshot.smaTrend !== 'neutral'
        && prev.smaTrend !== 'neutral') {
      alerts.push({
        id: `${symbol}-sma-${now}`,
        symbol,
        type: 'sma_cross',
        severity: 'strong',
        label: snapshot.smaTrend === 'bullish'
          ? `${symbol} 20-day average crossed above the 50-day`
          : `${symbol} 20-day average crossed below the 50-day`,
        note: 'A lagging trend indicator — crossovers confirm a trend after it has already started, not before.',
        at: now,
      });
    }

    // Volume spike newly triggered
    if (snapshot.volumeSpike?.isSpike && !prev.volumeSpike) {
      alerts.push({
        id: `${symbol}-vol-${now}`,
        symbol,
        type: 'volume_spike',
        severity: snapshot.volumeSpike.ratio >= 4 ? 'strong' : 'mild',
        label: `${symbol} volume is ${snapshot.volumeSpike.ratio?.toFixed(1)}x its recent average`,
        note: "Unusual volume often accompanies news — check the feed for context. Volume alone doesn't say which direction.",
        at: now,
      });
    }

    // MACD histogram sign flip
    const curMacdSign = snapshot.macdHistogram == null ? null : Math.sign(snapshot.macdHistogram);
    if (prev.macdSign != null && curMacdSign != null
        && prev.macdSign !== curMacdSign && curMacdSign !== 0) {
      alerts.push({
        id: `${symbol}-macd-${now}`,
        symbol,
        type: 'macd_flip',
        severity: 'mild',
        label: curMacdSign > 0
          ? `${symbol} MACD histogram turned positive`
          : `${symbol} MACD histogram turned negative`,
        note: 'A momentum reading — histogram sign flips are frequent and many do not lead to a sustained move.',
        at: now,
      });
    }

    // ADX crossing into trending territory. Fixed: was reading prev.adxStrength
    // which was never stored — correct key is prev.adxValue compared as strength string.
    const curAdxStrength = snapshot.adx?.strength ?? null;
    const prevAdxStrength = prev.adxStrength ?? null; // stored correctly below now
    if (prevAdxStrength && curAdxStrength && prevAdxStrength !== curAdxStrength
        && ['trending', 'strong_trend'].includes(curAdxStrength)
        && !['trending', 'strong_trend'].includes(prevAdxStrength)) {
      alerts.push({
        id: `${symbol}-adx-${now}`,
        symbol,
        type: 'adx_trend',
        severity: curAdxStrength === 'strong_trend' ? 'strong' : 'mild',
        label: `${symbol} ADX entered trending territory (${snapshot.adx.value}, +DI ${snapshot.adx.plusDI > snapshot.adx.minusDI ? 'leading' : 'behind'})`,
        note: 'ADX measures how persistent a move has been, not where it goes next.',
        at: now,
      });
    }

    // Ichimoku cloud break
    const curIchiPos  = snapshot.ichimoku?.position ?? null;
    const prevIchiPos = prev.ichimokuPosition ?? null;
    if (prevIchiPos && curIchiPos && curIchiPos !== prevIchiPos
        && ['above_cloud', 'below_cloud'].includes(curIchiPos)) {
      alerts.push({
        id: `${symbol}-ichimoku-${now}`,
        symbol,
        type: 'ichimoku_cloud',
        severity: 'mild',
        label: `${symbol} price moved ${curIchiPos === 'above_cloud' ? 'above' : 'below'} the Ichimoku cloud`,
        note: 'A trend-context marker — price can re-enter the cloud shortly after.',
        at: now,
      });
    }

    // Volatility regime change
    const curRegime  = snapshot.volatilityRegime?.regime ?? null;
    const prevRegime = prev.volRegime ?? null;
    if (prevRegime && curRegime && curRegime !== prevRegime && curRegime !== 'normal_volatility') {
      alerts.push({
        id: `${symbol}-volregime-${now}`,
        symbol,
        type: 'volatility_regime',
        severity: 'mild',
        label: `${symbol} entered a ${curRegime.replace(/_/g, ' ')} regime (ATR at ${snapshot.volatilityRegime.percentile}th percentile)`,
        note: 'Describes current volatility vs this asset\'s own recent history — not a directional call.',
        at: now,
      });
    }

    // Bollinger squeeze end (bands were narrow, now widening — often precedes a move)
    if (prev.bollSqueeze === true && snapshot.bollinger?.squeeze === false) {
      alerts.push({
        id: `${symbol}-bollsqueeze-${now}`,
        symbol,
        type: 'bollinger_squeeze_end',
        severity: 'mild',
        label: `${symbol} Bollinger Bands widening after a squeeze (bands were unusually tight)`,
        note: 'Band expansion after a squeeze often precedes a directional move — which direction is not implied.',
        at: now,
      });
    }
  }

  // Store state for next diff. All keys used in comparisons above must be here.
  db.setLastIndicatorState(symbol, {
    rsiZone:         snapshot.rsiZone,
    smaTrend:        snapshot.smaTrend,
    volumeSpike:     snapshot.volumeSpike?.isSpike ?? false,
    macdSign:        snapshot.macdHistogram == null ? null : Math.sign(snapshot.macdHistogram),
    adxStrength:     snapshot.adx?.strength ?? null,          // was missing — caused adx alerts to never fire
    ichimokuPosition: snapshot.ichimoku?.position ?? null,
    volRegime:       snapshot.volatilityRegime?.regime ?? null,
    bollSqueeze:     snapshot.bollinger?.squeeze ?? null,
  });

  return alerts;
}

module.exports = { detectAlerts };
