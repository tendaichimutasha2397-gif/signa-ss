'use strict';

const db = require('./db');

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL ENGINE
//
// Fires alerts only when state CHANGES — never on stable conditions that were
// already true last poll (which would spam the same alert every 2 minutes).
//
// Every alert is a descriptive statement about indicator behaviour, not a
// trade recommendation. Every alert carries a `note` and a `context` block
// reiterating that. Severity is computed from convergence: how many other
// indicators agree with what just changed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes a severity upgrade based on how many other indicators agree
 * with the direction of the new alert. Agreement lifts mild → moderate → strong.
 */
function severityFromAgreement(baseStrong, confluence, direction) {
  if (!confluence) return baseStrong ? 'strong' : 'mild';
  const agreeing = direction === 'up' ? confluence.up : confluence.down;
  const total    = confluence.total || 1;
  const pct      = agreeing / total;
  if (baseStrong || pct >= 0.6) return 'strong';
  if (pct >= 0.4)               return 'moderate';
  return 'mild';
}

function detectAlerts(symbol, snapshot) {
  const prev   = db.getLastIndicatorState(symbol);
  const alerts = [];
  const now    = new Date().toISOString();
  const conf   = snapshot.confluence;

  if (prev) {

    // ── 1. RSI zone change ────────────────────────────────────────────────────
    if (prev.rsiZone !== snapshot.rsiZone
        && snapshot.rsiZone !== 'neutral' && snapshot.rsiZone !== 'unknown') {
      const dist = snapshot.rsiZone === 'overbought' ? snapshot.rsi - 70 : 30 - snapshot.rsi;
      const dir  = snapshot.rsiZone === 'oversold' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-rsi-${now}`, symbol, type: 'rsi',
        severity: severityFromAgreement(dist >= 10, conf, dir),
        label: snapshot.rsiZone === 'overbought'
          ? `${symbol} RSI entered overbought (${snapshot.rsi})`
          : `${symbol} RSI entered oversold (${snapshot.rsi})`,
        context: `RSI ${snapshot.rsi} — ${conf ? `${conf.up} indicators leaning up, ${conf.down} leaning down` : ''}`,
        note: 'RSI extremes can persist for extended periods. Combine with trend direction and volume before acting.',
        at: now,
      });
    }

    // ── 2. SMA20/50 crossover ─────────────────────────────────────────────────
    if (prev.smaTrend !== snapshot.smaTrend
        && snapshot.smaTrend !== 'neutral' && prev.smaTrend !== 'neutral') {
      const dir = snapshot.smaTrend === 'bullish' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-sma-${now}`, symbol, type: 'sma_cross',
        severity: severityFromAgreement(true, conf, dir),
        label: snapshot.smaTrend === 'bullish'
          ? `${symbol} SMA20 crossed above SMA50`
          : `${symbol} SMA20 crossed below SMA50`,
        context: `200-day context: ${snapshot.longTrend || 'unknown'}`,
        note: 'Moving average crossovers confirm a trend after it has started — lagging by nature. More meaningful when aligned with the 200-day trend.',
        at: now,
      });
    }

    // ── 3. Price crossed 200-day SMA ──────────────────────────────────────────
    if (prev.longTrend && snapshot.longTrend && prev.longTrend !== snapshot.longTrend) {
      const dir = snapshot.longTrend === 'above_200sma' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-sma200-${now}`, symbol, type: 'sma200_cross',
        severity: severityFromAgreement(true, conf, dir),
        label: snapshot.longTrend === 'above_200sma'
          ? `${symbol} price crossed above the 200-day SMA`
          : `${symbol} price crossed below the 200-day SMA`,
        context: `Short-term trend: ${snapshot.smaTrend}`,
        note: 'The 200-day SMA is a widely-watched long-term trend divider. Crossings are significant but do not guarantee continuation.',
        at: now,
      });
    }

    // ── 4. Supertrend direction flip ─────────────────────────────────────────
    const curSTDir  = snapshot.supertrend?.direction ?? null;
    const prevSTDir = prev.supertrendDir ?? null;
    if (prevSTDir && curSTDir && prevSTDir !== curSTDir) {
      const dir = curSTDir === 'up' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-st-${now}`, symbol, type: 'supertrend_flip',
        severity: severityFromAgreement(true, conf, dir),
        label: curSTDir === 'up'
          ? `${symbol} Supertrend flipped bullish`
          : `${symbol} Supertrend flipped bearish`,
        context: `Line: $${snapshot.supertrend.line} · ADX: ${snapshot.adx?.value ?? 'n/a'}`,
        note: 'Supertrend uses ATR to set a trailing stop. Flips on low-ADX choppy markets generate more false signals.',
        at: now,
      });
    }

    // ── 5. PSAR trend flip ────────────────────────────────────────────────────
    const curPsarTrend  = snapshot.psar?.trend ?? null;
    const prevPsarTrend = prev.psarTrend ?? null;
    if (prevPsarTrend && curPsarTrend && prevPsarTrend !== curPsarTrend) {
      const dir = curPsarTrend === 'up' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-psar-${now}`, symbol, type: 'psar_flip',
        severity: severityFromAgreement(false, conf, dir),
        label: curPsarTrend === 'up'
          ? `${symbol} Parabolic SAR flipped bullish ($${snapshot.psar.value})`
          : `${symbol} Parabolic SAR flipped bearish ($${snapshot.psar.value})`,
        context: `Supertrend: ${curSTDir ?? 'n/a'} · SMA trend: ${snapshot.smaTrend}`,
        note: 'PSAR is acceleration-based — it accelerates in strong trends and whipsaws in ranges.',
        at: now,
      });
    }

    // ── 6. Momentum regime change ─────────────────────────────────────────────
    const curRegime  = snapshot.momentumRegime?.regime ?? null;
    const prevMomReg = prev.momentumRegime ?? null;
    if (prevMomReg && curRegime && prevMomReg !== curRegime) {
      const strong = curRegime === 'strong_bull' || curRegime === 'strong_bear';
      const dir    = curRegime.includes('bull') ? 'up' : curRegime.includes('bear') ? 'down' : 'flat';
      if (curRegime !== 'neutral') {
        alerts.push({
          id: `${symbol}-momreg-${now}`, symbol, type: 'momentum_regime',
          severity: severityFromAgreement(strong, conf, dir),
          label: `${symbol} momentum regime shifted to ${curRegime.replace('_', ' ')}`,
          context: `${snapshot.momentumRegime.bullVotes} bull votes vs ${snapshot.momentumRegime.bearVotes} bear votes across RSI, MACD, ADX direction, ROC, CMO`,
          note: 'A multi-indicator momentum read — agreement across 5 oscillators, not a single crossover. Still descriptive, not predictive.',
          at: now,
        });
      }
    }

    // ── 7. RSI divergence detected ────────────────────────────────────────────
    const curRsiDiv  = snapshot.divergence?.rsi ?? null;
    const prevRsiDiv = prev.rsiDivergenceType ?? null;
    if (curRsiDiv && curRsiDiv.type !== prevRsiDiv) {
      const dir = curRsiDiv.type === 'bullish' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-rsidiv-${now}`, symbol, type: 'rsi_divergence',
        severity: curRsiDiv.confidence === 'high' ? 'strong' : 'moderate',
        label: `${symbol} ${curRsiDiv.label} detected (${curRsiDiv.confidence} confidence)`,
        context: `Price moved ${curRsiDiv.pricePctGap}% while RSI diverged. Signal ${curRsiDiv.barsAgo} bars fresh.`,
        note: 'Divergence = price and momentum disagree. High-confidence divergences have historically preceded reversals more often than not — but the timing of the reversal is unknown.',
        at: now,
      });
    }

    // ── 8. MACD divergence detected ───────────────────────────────────────────
    const curMacdDiv  = snapshot.divergence?.macd ?? null;
    const prevMacdDiv = prev.macdDivergenceType ?? null;
    if (curMacdDiv && curMacdDiv.type !== prevMacdDiv) {
      const dir = curMacdDiv.type === 'bullish' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-macddiv-${now}`, symbol, type: 'macd_divergence',
        severity: curMacdDiv.confidence === 'high' ? 'strong' : 'moderate',
        label: `${symbol} ${curMacdDiv.label} detected (${curMacdDiv.confidence} confidence)`,
        context: `Price moved ${curMacdDiv.pricePctGap}% while MACD histogram diverged. ${curMacdDiv.barsAgo} bars fresh.`,
        note: 'MACD divergence is a leading read on momentum exhaustion — not a guarantee of reversal. Use with trend context.',
        at: now,
      });
    }

    // ── 9. MACD histogram sign flip ───────────────────────────────────────────
    const curMacdSign = snapshot.macdHistogram == null ? null : Math.sign(snapshot.macdHistogram);
    if (prev.macdSign != null && curMacdSign != null
        && prev.macdSign !== curMacdSign && curMacdSign !== 0) {
      const dir = curMacdSign > 0 ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-macd-${now}`, symbol, type: 'macd_flip',
        severity: severityFromAgreement(false, conf, dir),
        label: curMacdSign > 0
          ? `${symbol} MACD histogram turned positive`
          : `${symbol} MACD histogram turned negative`,
        context: `Hist: ${snapshot.macdHistogram} · Line: ${snapshot.macdLine ?? 'n/a'} vs Signal: ${snapshot.macdSignal ?? 'n/a'}`,
        note: 'Histogram sign flips are frequent. More meaningful when MACD line also crosses signal line, or when aligned with a trend signal.',
        at: now,
      });
    }

    // ── 10. Volume spike ─────────────────────────────────────────────────────
    if (snapshot.volumeSpike?.isSpike && !prev.volumeSpike) {
      alerts.push({
        id: `${symbol}-vol-${now}`, symbol, type: 'volume_spike',
        severity: (snapshot.volumeSpike.ratio ?? 0) >= 4 ? 'strong' : 'moderate',
        label: `${symbol} volume is ${snapshot.volumeSpike.ratio?.toFixed(1)}x its 20-day average`,
        context: `Current volume: ${snapshot.volumeSpike.current?.toLocaleString()} vs avg ${snapshot.volumeSpike.avg?.toFixed(0)}`,
        note: 'Unusual volume often accompanies news or institutional activity. Check the feed. Volume alone does not imply direction.',
        at: now,
      });
    }

    // ── 11. ADX entering trending territory ──────────────────────────────────
    const curAdxStrength  = snapshot.adx?.strength ?? null;
    const prevAdxStrength = prev.adxStrength ?? null;
    if (prevAdxStrength && curAdxStrength && prevAdxStrength !== curAdxStrength
        && ['trending', 'strong_trend'].includes(curAdxStrength)
        && !['trending', 'strong_trend'].includes(prevAdxStrength)) {
      const dir = snapshot.adx.plusDI > snapshot.adx.minusDI ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-adx-${now}`, symbol, type: 'adx_trend',
        severity: curAdxStrength === 'strong_trend' ? 'strong' : 'moderate',
        label: `${symbol} ADX entered ${curAdxStrength === 'strong_trend' ? 'strong trend' : 'trending'} territory (${snapshot.adx.value})`,
        context: `+DI: ${snapshot.adx.plusDI} vs -DI: ${snapshot.adx.minusDI} (${snapshot.adx.plusDI > snapshot.adx.minusDI ? 'bulls leading' : 'bears leading'})`,
        note: 'ADX measures how persistent a trend has been — not direction. Combined with +DI/-DI for direction context.',
        at: now,
      });
    }

    // ── 12. ADX dropping back to range-bound ─────────────────────────────────
    if (prevAdxStrength && curAdxStrength && prevAdxStrength !== curAdxStrength
        && curAdxStrength === 'range_bound'
        && ['trending', 'strong_trend'].includes(prevAdxStrength)) {
      alerts.push({
        id: `${symbol}-adx-weak-${now}`, symbol, type: 'adx_weakening',
        severity: 'mild',
        label: `${symbol} ADX dropped back to range-bound (${snapshot.adx?.value}) — trend may be losing momentum`,
        context: `Was: ${prevAdxStrength.replace('_', ' ')}`,
        note: 'Trend strength fading. Breakout follow-through less reliable. Range strategies may become more applicable.',
        at: now,
      });
    }

    // ── 13. Ichimoku cloud break ──────────────────────────────────────────────
    const curIchiPos  = snapshot.ichimoku?.position ?? null;
    const prevIchiPos = prev.ichimokuPosition ?? null;
    if (prevIchiPos && curIchiPos && curIchiPos !== prevIchiPos
        && ['above_cloud', 'below_cloud'].includes(curIchiPos)) {
      const dir = curIchiPos === 'above_cloud' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-ichi-${now}`, symbol, type: 'ichimoku_cloud',
        severity: severityFromAgreement(false, conf, dir),
        label: `${symbol} price moved ${curIchiPos === 'above_cloud' ? 'above' : 'below'} the Ichimoku cloud`,
        context: `Tenkan: ${snapshot.ichimoku?.tenkan?.toFixed(2)} · Kijun: ${snapshot.ichimoku?.kijun?.toFixed(2)} · TK cross: ${snapshot.ichimoku?.tkCross ?? 'n/a'}`,
        note: 'Cloud breaks are a trend-context shift. Price can re-enter the cloud. Most reliable when confirmed by volume and ADX.',
        at: now,
      });
    }

    // ── 14. Volatility regime change ──────────────────────────────────────────
    const curVolRegime  = snapshot.volatilityRegime?.regime ?? null;
    const prevVolRegime = prev.volRegime ?? null;
    if (prevVolRegime && curVolRegime && curVolRegime !== prevVolRegime
        && curVolRegime !== 'normal_volatility') {
      alerts.push({
        id: `${symbol}-volreg-${now}`, symbol, type: 'volatility_regime',
        severity: 'moderate',
        label: `${symbol} entered ${curVolRegime.replace(/_/g, ' ')} (ATR at ${snapshot.volatilityRegime.percentile}th percentile)`,
        context: `ATR(14): ${snapshot.atr14} · Prior regime: ${prevVolRegime.replace(/_/g, ' ')}`,
        note: 'Volatility regime describes ATR vs this asset\'s own history. High-vol: widen stops. Low-vol: often precedes a breakout.',
        at: now,
      });
    }

    // ── 15. Bollinger squeeze fire (BB inside Keltner = true squeeze) ────────
    const curSqueeze  = snapshot.keltner?.squeeze ?? snapshot.bollinger?.squeeze ?? null;
    const prevSqueeze = prev.keltnerSqueeze ?? prev.bollSqueeze ?? null;
    if (prevSqueeze === true && curSqueeze === false) {
      alerts.push({
        id: `${symbol}-squeeze-${now}`, symbol, type: 'squeeze_fire',
        severity: 'strong',
        label: `${symbol} Bollinger-Keltner squeeze released — watch for directional move`,
        context: `BB width: ${snapshot.bollinger?.width?.toFixed(4) ?? 'n/a'} · Momentum regime: ${snapshot.momentumRegime?.regime ?? 'n/a'}`,
        note: 'A true squeeze fires when Bollinger Bands contract inside Keltner Channels. The squeeze release often precedes a sharp move — check momentum regime for direction bias.',
        at: now,
      });
    }

    // ── 16. Aroon trend shift ─────────────────────────────────────────────────
    const curAroonBias  = snapshot.aroon?.bias ?? null;
    const prevAroonBias = prev.aroonBias ?? null;
    if (prevAroonBias && curAroonBias && prevAroonBias !== curAroonBias
        && (curAroonBias === 'strong_bull' || curAroonBias === 'strong_bear')) {
      const dir = curAroonBias === 'strong_bull' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-aroon-${now}`, symbol, type: 'aroon_trend',
        severity: severityFromAgreement(false, conf, dir),
        label: `${symbol} Aroon entered ${curAroonBias.replace('_', ' ')} zone (osc: ${snapshot.aroon.oscillator})`,
        context: `Prior: ${prevAroonBias.replace('_', ' ')}`,
        note: 'Aroon measures how recently swing highs/lows occurred. A strong Aroon reading means a new high/low just formed — trend follow-through context.',
        at: now,
      });
    }

    // ── 17. MFI overbought/oversold ───────────────────────────────────────────
    const curMfiZone  = snapshot.mfi != null ? (snapshot.mfi >= 80 ? 'overbought' : snapshot.mfi <= 20 ? 'oversold' : 'neutral') : null;
    const prevMfiZone = prev.mfiZone ?? null;
    if (prevMfiZone && curMfiZone && prevMfiZone !== curMfiZone && curMfiZone !== 'neutral') {
      const dir = curMfiZone === 'oversold' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-mfi-${now}`, symbol, type: 'mfi_extreme',
        severity: severityFromAgreement(false, conf, dir),
        label: `${symbol} MFI entered ${curMfiZone} zone (${snapshot.mfi})`,
        context: `Volume-weighted RSI — combines price direction and volume to measure money flow strength`,
        note: 'MFI is like RSI but weighted by volume — a more complete picture of buying/selling pressure. Extremes can persist.',
        at: now,
      });
    }

    // ── 18. Multi-indicator confluence surge (≥70% agreement) ────────────────
    const curPct  = conf ? Math.max(conf.up, conf.down) / (conf.total || 1) : 0;
    const prevPct = prev.confluencePct ?? 0;
    const curDir  = conf ? (conf.up >= conf.down ? 'up' : 'down') : null;
    if (curPct >= 0.70 && prevPct < 0.70 && curDir && conf) {
      alerts.push({
        id: `${symbol}-confluence-${now}`, symbol, type: 'confluence_surge',
        severity: curPct >= 0.80 ? 'strong' : 'moderate',
        label: `${symbol} ${Math.round(curPct * 100)}% of indicators leaning ${curDir} — rare confluence`,
        context: `${conf.up} up / ${conf.down} down / ${conf.flat} flat out of ${conf.total} indicators`,
        note: 'Unusually high indicator agreement. Still a description of current conditions — not a guarantee. The strongest confluence readings often occur after a large move is already underway.',
        at: now,
      });
    }

    // ── 19. Elder Ray signal shift ────────────────────────────────────────────
    const curErSignal  = snapshot.elderRay?.signal ?? null;
    const prevErSignal = prev.elderRaySignal ?? null;
    if (curErSignal && prevErSignal && curErSignal !== prevErSignal
        && ['strong_bull', 'strong_bear'].includes(curErSignal)) {
      const dir = curErSignal === 'strong_bull' ? 'up' : 'down';
      alerts.push({
        id: `${symbol}-elder-${now}`, symbol, type: 'elder_ray',
        severity: severityFromAgreement(false, conf, dir),
        label: `${symbol} Elder Ray shifted to ${curErSignal.replace('_', ' ')} (both Bull + Bear Power ${curErSignal === 'strong_bull' ? 'positive' : 'negative'})`,
        context: `Bull power: ${snapshot.elderRay.bullPower} · Bear power: ${snapshot.elderRay.bearPower}`,
        note: 'When both Bull and Bear Power are positive, bulls control both peaks and troughs. The opposite for bears. Transitions are significant.',
        at: now,
      });
    }

    // ── 20. ROC extreme (momentum impulse) ───────────────────────────────────
    const curRoc  = snapshot.roc ?? null;
    const prevRoc = prev.roc ?? null;
    if (curRoc != null && prevRoc != null) {
      const threshold = 8; // > 8% in 10 bars = notable impulse
      if (Math.abs(curRoc) >= threshold && Math.abs(prevRoc) < threshold) {
        const dir = curRoc > 0 ? 'up' : 'down';
        alerts.push({
          id: `${symbol}-roc-${now}`, symbol, type: 'roc_impulse',
          severity: Math.abs(curRoc) >= 15 ? 'strong' : 'moderate',
          label: `${symbol} ROC(10) hit ${curRoc > 0 ? '+' : ''}${curRoc}% — momentum impulse`,
          context: `Price moved ${Math.abs(curRoc).toFixed(1)}% in the last 10 bars`,
          note: 'Rate-of-change spike indicates a sharp move. Check volume and news. Extreme ROC often mean-reverts but can persist in strong trends.',
          at: now,
        });
      }
    }

  } // end if(prev)

  // ─── Store state for next diff ─────────────────────────────────────────────
  db.setLastIndicatorState(symbol, {
    rsiZone:            snapshot.rsiZone,
    smaTrend:           snapshot.smaTrend,
    longTrend:          snapshot.longTrend,
    volumeSpike:        snapshot.volumeSpike?.isSpike ?? false,
    macdSign:           snapshot.macdHistogram == null ? null : Math.sign(snapshot.macdHistogram),
    adxStrength:        snapshot.adx?.strength ?? null,
    ichimokuPosition:   snapshot.ichimoku?.position ?? null,
    volRegime:          snapshot.volatilityRegime?.regime ?? null,
    bollSqueeze:        snapshot.bollinger?.squeeze ?? null,
    keltnerSqueeze:     snapshot.keltner?.squeeze ?? null,
    supertrendDir:      snapshot.supertrend?.direction ?? null,
    psarTrend:          snapshot.psar?.trend ?? null,
    momentumRegime:     snapshot.momentumRegime?.regime ?? null,
    rsiDivergenceType:  snapshot.divergence?.rsi?.type ?? null,
    macdDivergenceType: snapshot.divergence?.macd?.type ?? null,
    aroonBias:          snapshot.aroon?.bias ?? null,
    mfiZone:            snapshot.mfi != null ? (snapshot.mfi >= 80 ? 'overbought' : snapshot.mfi <= 20 ? 'oversold' : 'neutral') : null,
    confluencePct:      conf ? Math.max(conf.up, conf.down) / (conf.total || 1) : 0,
    elderRaySignal:     snapshot.elderRay?.signal ?? null,
    roc:                snapshot.roc ?? null,
  });

  return alerts;
}

module.exports = { detectAlerts };
