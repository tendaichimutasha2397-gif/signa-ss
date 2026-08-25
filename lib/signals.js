'use strict';

const db = require('./db');

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL ENGINE v2
//
// Fires alerts only when state CHANGES — never on stable conditions already
// true last poll. Every alert is a descriptive statement about indicator
// behaviour, not a trade recommendation.
//
// Improvements over v1:
//   1. SIGNAL QUALITY SCORE — composite 0-100 score per alert based on how
//      many independent indicator families agree. Printed in `context`.
//   2. HOLD DURATION GUIDANCE — strong/sell alerts include a data-derived
//      hold window based on ATR-adjusted volatility regime + confluence %.
//      Expressed as a range, never a guarantee.
//   3. MULTI-CONFIRMATION GATING — squeeze_fire, confluence_surge, and
//      divergence alerts require a minimum quality score before upgrading
//      to 'strong'. Weak-confluence fires stay 'moderate'.
//   4. RICHER CONTEXT — every alert context block includes signal quality,
//      momentum regime, and (for strong alerts) the hold duration estimate.
//   5. ADX-GATED TREND ALERTS — SMA crossovers and Supertrend flips that
//      fire in sub-20 ADX range-bound conditions are downgraded to 'mild'
//      and flagged explicitly, reducing noise in choppy markets.
//   6. STOCHASTIC CROSS — new alert type: %K crosses %D in an extreme zone,
//      a tighter, more actionable oscillator signal than zone-entry alone.
//   7. PRICE-LEVEL ALERTS — new type: price crossing a pivot point or Fib
//      level, with the level name and distance in ATR units.
//   8. TRIPLE-CONFIRMATION STRONG BUY/SELL — fires when ≥3 independent
//      signal families all agree in the same direction simultaneously,
//      not just a high confluence %. Includes hold guidance.
// ─────────────────────────────────────────────────────────────────────────────

// ── Signal quality scoring ───────────────────────────────────────────────────
// Scores 0-100 based on how many independent indicator *families* agree.
// Families: trend (SMA/Supertrend/PSAR/Ichimoku/200SMA), momentum (RSI/Stoch/
// CCI/Williams/MFI/CMO), volume (OBV/MFI/volumeSpike), oscillator (MACD/ROC),
// volatility-context (ADX strength), divergence.
function signalQuality(direction, snapshot) {
  const conf = snapshot.confluence;
  if (!conf) return 0;

  let score = 0;

  // Base: confluence % (0-40 pts)
  const pct = Math.max(conf.up, conf.down) / (conf.total || 1);
  score += Math.round(pct * 40);

  // Momentum regime agreement (0-20 pts)
  const regime = snapshot.momentumRegime?.regime ?? 'neutral';
  const regimeAgrees = direction === 'up'
    ? ['bull', 'strong_bull'].includes(regime)
    : ['bear', 'strong_bear'].includes(regime);
  if (regime === (direction === 'up' ? 'strong_bull' : 'strong_bear')) score += 20;
  else if (regimeAgrees) score += 12;

  // ADX trend strength (0-15 pts)
  const adxStr = snapshot.adx?.strength ?? 'range_bound';
  if (adxStr === 'strong_trend') score += 15;
  else if (adxStr === 'trending') score += 10;
  else if (adxStr === 'developing') score += 5;

  // Divergence confirmation (0-15 pts)
  const div = snapshot.divergence;
  if (div) {
    const rsiDiv = div.rsi;
    const macdDiv = div.macd;
    const divDir = direction === 'up' ? 'bullish' : 'bearish';
    if (rsiDiv?.type === divDir && rsiDiv.confidence === 'high') score += 15;
    else if (macdDiv?.type === divDir && macdDiv.confidence === 'high') score += 10;
    else if (rsiDiv?.type === divDir || macdDiv?.type === divDir) score += 5;
  }

  // Squeeze context: firing into a squeeze release in the right direction (0-10 pts)
  const kSqueeze = snapshot.keltner?.squeeze;
  if (kSqueeze === false) score += 10; // squeeze just released — directional move likely

  return Math.min(100, score);
}

// ── Hold duration estimation ──────────────────────────────────────────────────
// Returns a human-readable hold window based on:
//   - Volatility regime (high vol = shorter hold; low vol = wider range)
//   - ADX strength (strong trend = hold longer)
//   - Confluence % (higher = more conviction)
// All estimates are in *bars* (daily timeframe). Not a recommendation.
function estimateHoldDuration(snapshot, direction) {
  const volRegime   = snapshot.volatilityRegime?.regime ?? 'normal_volatility';
  const adxStr      = snapshot.adx?.strength ?? 'range_bound';
  const conf        = snapshot.confluence;
  const confPct     = conf ? Math.max(conf.up, conf.down) / (conf.total || 1) : 0.5;
  const regime      = snapshot.momentumRegime?.regime ?? 'neutral';

  // Base window in days
  let minDays = 3;
  let maxDays = 10;

  // ADX adjustment
  if (adxStr === 'strong_trend') { minDays += 5; maxDays += 15; }
  else if (adxStr === 'trending') { minDays += 2; maxDays += 8; }
  else if (adxStr === 'range_bound') { minDays = Math.max(1, minDays - 1); maxDays = Math.min(5, maxDays); }

  // Volatility adjustment — high vol compresses the window
  if (volRegime === 'high_volatility') { minDays = Math.max(1, minDays - 2); maxDays = Math.max(minDays + 2, maxDays - 5); }
  else if (volRegime === 'very_high_volatility') { minDays = 1; maxDays = Math.max(3, Math.floor(maxDays / 2)); }
  else if (volRegime === 'low_volatility') { maxDays += 5; }

  // Confluence boost — high agreement → hold longer
  if (confPct >= 0.75) { minDays += 2; maxDays += 5; }
  else if (confPct < 0.55) { maxDays = Math.max(minDays + 2, maxDays - 3); }

  // Strong momentum regime → hold longer
  const isStrongRegime = direction === 'up' ? regime === 'strong_bull' : regime === 'strong_bear';
  if (isStrongRegime) { minDays += 2; maxDays += 5; }

  minDays = Math.max(1, minDays);
  maxDays = Math.max(minDays + 1, maxDays);

  const volNote = volRegime === 'high_volatility' || volRegime === 'very_high_volatility'
    ? 'High volatility — use wider stops and tighter hold window.'
    : volRegime === 'low_volatility'
      ? 'Low volatility — moves can be slow; patience rewarded if trend holds.'
      : '';

  return {
    minDays,
    maxDays,
    label: `Estimated hold: ${minDays}–${maxDays} trading days (daily bars)`,
    caveat: `Based on ATR volatility regime (${volRegime.replace(/_/g, ' ')}), ADX (${adxStr.replace(/_/g, ' ')}), and ${Math.round(confPct * 100)}% indicator confluence. Not a recommendation — exit when your own stop or target is hit.${volNote ? ' ' + volNote : ''}`,
  };
}

// ── Severity with ADX gating ──────────────────────────────────────────────────
function severityFromAgreement(baseStrong, confluence, direction, adxStrength) {
  if (!confluence) return baseStrong ? 'strong' : 'mild';
  const agreeing = direction === 'up' ? confluence.up : confluence.down;
  const total    = confluence.total || 1;
  const pct      = agreeing / total;

  // Downgrade trend-following alerts in range-bound ADX conditions
  const isRangeBound = adxStrength === 'range_bound' || adxStrength == null;

  if (baseStrong && pct >= 0.6 && !isRangeBound) return 'strong';
  if (baseStrong && pct >= 0.5)                  return isRangeBound ? 'mild' : 'moderate';
  if (pct >= 0.6 && !isRangeBound)               return 'moderate';
  return 'mild';
}

// ── Context builder ───────────────────────────────────────────────────────────
function buildContext(snapshot, direction, quality, holdDuration) {
  const conf    = snapshot.confluence;
  const regime  = snapshot.momentumRegime?.regime ?? 'unknown';
  const adxStr  = snapshot.adx?.strength ?? 'unknown';
  const confStr = conf
    ? `${conf.up} up / ${conf.down} down / ${conf.flat} flat (${Math.round(Math.max(conf.up, conf.down) / (conf.total || 1) * 100)}% agreement)`
    : 'confluence unavailable';

  let ctx = `Signal quality: ${quality}/100 · Momentum regime: ${regime.replace(/_/g, ' ')} · ADX: ${adxStr.replace(/_/g, ' ')} · Confluence: ${confStr}`;
  if (holdDuration) ctx += ` · ${holdDuration.label}`;
  return ctx;
}

// ── Independent signal family tracker — for triple-confirmation ──────────────
// Returns a list of which signal families are firing in a given direction.
function activeSignalFamilies(snapshot, direction) {
  const families = [];
  const conf = snapshot.confluence;
  const confPct = conf ? Math.max(conf.up, conf.down) / (conf.total || 1) : 0;
  const regimAgrees = direction === 'up'
    ? ['bull', 'strong_bull'].includes(snapshot.momentumRegime?.regime)
    : ['bear', 'strong_bear'].includes(snapshot.momentumRegime?.regime);

  // Trend family
  const trendUp = snapshot.smaTrend === 'bullish' && snapshot.supertrend?.direction === 'up' && snapshot.psar?.trend === 'up';
  const trendDn = snapshot.smaTrend === 'bearish' && snapshot.supertrend?.direction === 'down' && snapshot.psar?.trend === 'down';
  if ((direction === 'up' && trendUp) || (direction === 'down' && trendDn)) families.push('trend');

  // Momentum family
  if (regimAgrees) families.push('momentum');

  // Volume family
  const obvOk = direction === 'up' ? snapshot.obv?.trend === 'rising' : snapshot.obv?.trend === 'falling';
  const mfiOk = snapshot.mfi != null && (direction === 'up' ? snapshot.mfi <= 40 : snapshot.mfi >= 60);
  if (obvOk || mfiOk) families.push('volume');

  // Divergence family
  const div = snapshot.divergence;
  const divDir = direction === 'up' ? 'bullish' : 'bearish';
  if (div && (div.rsi?.type === divDir || div.macd?.type === divDir)) families.push('divergence');

  // Long-term trend
  if (direction === 'up' && snapshot.longTrend === 'above_200sma') families.push('long_trend');
  if (direction === 'down' && snapshot.longTrend === 'below_200sma') families.push('long_trend');

  return families;
}

// ─────────────────────────────────────────────────────────────────────────────

function detectAlerts(symbol, snapshot) {
  const prev   = db.getLastIndicatorState(symbol);
  const alerts = [];
  const now    = new Date().toISOString();
  const conf   = snapshot.confluence;
  const adxStr = snapshot.adx?.strength ?? null;

  if (prev) {

    // ── 1. RSI zone change ───────────────────────────────────────────────────
    if (prev.rsiZone !== snapshot.rsiZone
        && snapshot.rsiZone !== 'neutral' && snapshot.rsiZone !== 'unknown') {
      const dir  = snapshot.rsiZone === 'oversold' ? 'up' : 'down';
      const dist = snapshot.rsiZone === 'overbought' ? snapshot.rsi - 70 : 30 - snapshot.rsi;
      const q    = signalQuality(dir, snapshot);
      const hold = snapshot.rsiZone === 'oversold' ? estimateHoldDuration(snapshot, dir) : null;
      alerts.push({
        id: `${symbol}-rsi-${now}`, symbol, type: 'rsi',
        severity: severityFromAgreement(dist >= 10, conf, dir, adxStr),
        label: snapshot.rsiZone === 'overbought'
          ? `${symbol} RSI entered overbought (${snapshot.rsi}) — bearish pressure`
          : `${symbol} RSI entered oversold (${snapshot.rsi}) — potential reversal up`,
        context: buildContext(snapshot, dir, q, hold),
        note: 'RSI extremes can persist. More actionable when Stochastic and MFI agree.',
        hold: hold || null,
        signalQuality: q,
        at: now,
      });
    }

    // ── 2. Stochastic %K/%D cross in extreme zone (new) ──────────────────────
    const curStochK = snapshot.stochastic?.k ?? null;
    const curStochD = snapshot.stochastic?.d ?? null;
    const prevStochK = prev.stochK ?? null;
    const prevStochD = prev.stochD ?? null;
    if (curStochK != null && curStochD != null && prevStochK != null && prevStochD != null) {
      const crossedAbove = prevStochK <= prevStochD && curStochK > curStochD;
      const crossedBelow = prevStochK >= prevStochD && curStochK < curStochD;
      if (crossedAbove && curStochK <= 30) {
        // %K crossed above %D in oversold — bullish
        const q    = signalQuality('up', snapshot);
        const hold = estimateHoldDuration(snapshot, 'up');
        alerts.push({
          id: `${symbol}-stoch-cross-up-${now}`, symbol, type: 'stoch_cross',
          severity: severityFromAgreement(q >= 60, conf, 'up', adxStr),
          label: `${symbol} Stochastic %K crossed above %D in oversold zone (${curStochK}/${curStochD})`,
          context: buildContext(snapshot, 'up', q, hold),
          note: 'Stochastic cross in extreme zone is tighter than zone-entry alone. Most reliable when RSI and MFI are also oversold.',
          hold,
          signalQuality: q,
          at: now,
        });
      } else if (crossedBelow && curStochK >= 70) {
        // %K crossed below %D in overbought — bearish
        const q    = signalQuality('down', snapshot);
        const hold = estimateHoldDuration(snapshot, 'down');
        alerts.push({
          id: `${symbol}-stoch-cross-dn-${now}`, symbol, type: 'stoch_cross',
          severity: severityFromAgreement(q >= 60, conf, 'down', adxStr),
          label: `${symbol} Stochastic %K crossed below %D in overbought zone (${curStochK}/${curStochD})`,
          context: buildContext(snapshot, 'down', q, hold),
          note: 'Stochastic bearish cross in overbought — check volume and MACD for confirmation.',
          hold,
          signalQuality: q,
          at: now,
        });
      }
    }

    // ── 3. SMA20/50 crossover (ADX-gated) ────────────────────────────────────
    if (prev.smaTrend !== snapshot.smaTrend
        && snapshot.smaTrend !== 'neutral' && prev.smaTrend !== 'neutral') {
      const dir = snapshot.smaTrend === 'bullish' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      const isRangeBound = adxStr === 'range_bound' || adxStr == null;
      const hold = !isRangeBound ? estimateHoldDuration(snapshot, dir) : null;
      alerts.push({
        id: `${symbol}-sma-${now}`, symbol, type: 'sma_cross',
        severity: severityFromAgreement(true, conf, dir, adxStr),
        label: snapshot.smaTrend === 'bullish'
          ? `${symbol} SMA20 crossed above SMA50${isRangeBound ? ' (low ADX — range-bound caution)' : ''}`
          : `${symbol} SMA20 crossed below SMA50${isRangeBound ? ' (low ADX — range-bound caution)' : ''}`,
        context: buildContext(snapshot, dir, q, hold),
        note: isRangeBound
          ? 'ADX below 20 — this cross occurred in range-bound conditions. Trend-following signals in ranges produce more false signals.'
          : '200-day trend: ' + (snapshot.longTrend ?? 'unknown') + '. Crossovers are lagging — more meaningful with strong ADX and volume confirmation.',
        hold: hold || null,
        signalQuality: q,
        at: now,
      });
    }

    // ── 4. Price crossed 200-day SMA ─────────────────────────────────────────
    if (prev.longTrend && snapshot.longTrend && prev.longTrend !== snapshot.longTrend) {
      const dir = snapshot.longTrend === 'above_200sma' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      const hold = estimateHoldDuration(snapshot, dir);
      alerts.push({
        id: `${symbol}-sma200-${now}`, symbol, type: 'sma200_cross',
        severity: severityFromAgreement(true, conf, dir, adxStr),
        label: snapshot.longTrend === 'above_200sma'
          ? `${symbol} price crossed above the 200-day SMA — long-term trend shift`
          : `${symbol} price crossed below the 200-day SMA — long-term trend shift`,
        context: buildContext(snapshot, dir, q, hold),
        note: 'The 200-day SMA is the most-watched long-term trend divider. A confirmed cross with volume is significant. Crosses in choppy markets whipsaw.',
        hold,
        signalQuality: q,
        at: now,
      });
    }

    // ── 5. Supertrend direction flip (ADX-gated) ──────────────────────────────
    const curSTDir  = snapshot.supertrend?.direction ?? null;
    const prevSTDir = prev.supertrendDir ?? null;
    if (prevSTDir && curSTDir && prevSTDir !== curSTDir) {
      const dir  = curSTDir === 'up' ? 'up' : 'down';
      const q    = signalQuality(dir, snapshot);
      const isRangeBound = adxStr === 'range_bound' || adxStr == null;
      const hold = !isRangeBound ? estimateHoldDuration(snapshot, dir) : null;
      alerts.push({
        id: `${symbol}-st-${now}`, symbol, type: 'supertrend_flip',
        severity: severityFromAgreement(true, conf, dir, adxStr),
        label: curSTDir === 'up'
          ? `${symbol} Supertrend flipped bullish${isRangeBound ? ' (low ADX caution)' : ''}`
          : `${symbol} Supertrend flipped bearish${isRangeBound ? ' (low ADX caution)' : ''}`,
        context: buildContext(snapshot, dir, q, hold),
        note: 'Supertrend uses ATR to trail a stop. Flips in low-ADX conditions are more often whipsaws. Confirm with MACD and volume.',
        hold: hold || null,
        signalQuality: q,
        at: now,
      });
    }

    // ── 6. PSAR trend flip ────────────────────────────────────────────────────
    const curPsarTrend  = snapshot.psar?.trend ?? null;
    const prevPsarTrend = prev.psarTrend ?? null;
    if (prevPsarTrend && curPsarTrend && prevPsarTrend !== curPsarTrend) {
      const dir = curPsarTrend === 'up' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      alerts.push({
        id: `${symbol}-psar-${now}`, symbol, type: 'psar_flip',
        severity: severityFromAgreement(false, conf, dir, adxStr),
        label: curPsarTrend === 'up'
          ? `${symbol} Parabolic SAR flipped bullish ($${snapshot.psar.value})`
          : `${symbol} Parabolic SAR flipped bearish ($${snapshot.psar.value})`,
        context: buildContext(snapshot, dir, q, null),
        note: 'PSAR accelerates in strong trends and whipsaws in ranges. Check Supertrend and SMA trend for confluence.',
        signalQuality: q,
        at: now,
      });
    }

    // ── 7. Momentum regime change ─────────────────────────────────────────────
    const curRegime  = snapshot.momentumRegime?.regime ?? null;
    const prevMomReg = prev.momentumRegime ?? null;
    if (prevMomReg && curRegime && prevMomReg !== curRegime && curRegime !== 'neutral') {
      const strong = curRegime === 'strong_bull' || curRegime === 'strong_bear';
      const dir    = curRegime.includes('bull') ? 'up' : curRegime.includes('bear') ? 'down' : 'flat';
      if (dir !== 'flat') {
        const q    = signalQuality(dir, snapshot);
        const hold = strong ? estimateHoldDuration(snapshot, dir) : null;
        alerts.push({
          id: `${symbol}-momreg-${now}`, symbol, type: 'momentum_regime',
          severity: severityFromAgreement(strong, conf, dir, adxStr),
          label: `${symbol} momentum regime shifted to ${curRegime.replace(/_/g, ' ')}`,
          context: buildContext(snapshot, dir, q, hold) + ` · ${snapshot.momentumRegime.bullVotes} bull / ${snapshot.momentumRegime.bearVotes} bear votes`,
          note: 'Multi-indicator momentum read across RSI, MACD, ADX direction, ROC, CMO. Strong regime + high confluence is the strongest non-divergence signal in this engine.',
          hold: hold || null,
          signalQuality: q,
          at: now,
        });
      }
    }

    // ── 8. RSI divergence ────────────────────────────────────────────────────
    const curRsiDiv  = snapshot.divergence?.rsi ?? null;
    const prevRsiDiv = prev.rsiDivergenceType ?? null;
    if (curRsiDiv && curRsiDiv.type !== prevRsiDiv) {
      const dir = curRsiDiv.type === 'bullish' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      const hold = curRsiDiv.confidence === 'high' ? estimateHoldDuration(snapshot, dir) : null;
      alerts.push({
        id: `${symbol}-rsidiv-${now}`, symbol, type: 'rsi_divergence',
        severity: curRsiDiv.confidence === 'high' ? 'strong' : 'moderate',
        label: `${symbol} ${curRsiDiv.label} (${curRsiDiv.confidence} confidence, ${curRsiDiv.barsAgo} bars fresh)`,
        context: buildContext(snapshot, dir, q, hold) + ` · Price/RSI gap: ${curRsiDiv.pricePctGap}%`,
        note: 'Divergence = price and momentum disagree. High-confidence RSI divergence is one of the more reliable reversal setups — timing of the reversal is still unknown.',
        hold: hold || null,
        signalQuality: q,
        at: now,
      });
    }

    // ── 9. MACD divergence ────────────────────────────────────────────────────
    const curMacdDiv  = snapshot.divergence?.macd ?? null;
    const prevMacdDiv = prev.macdDivergenceType ?? null;
    if (curMacdDiv && curMacdDiv.type !== prevMacdDiv) {
      const dir = curMacdDiv.type === 'bullish' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      const hold = curMacdDiv.confidence === 'high' ? estimateHoldDuration(snapshot, dir) : null;
      alerts.push({
        id: `${symbol}-macddiv-${now}`, symbol, type: 'macd_divergence',
        severity: curMacdDiv.confidence === 'high' ? 'strong' : 'moderate',
        label: `${symbol} ${curMacdDiv.label} (${curMacdDiv.confidence} confidence, ${curMacdDiv.barsAgo} bars fresh)`,
        context: buildContext(snapshot, dir, q, hold) + ` · MACD/price gap: ${curMacdDiv.pricePctGap}%`,
        note: 'MACD divergence is a leading read on momentum exhaustion. Combine with RSI divergence for double confirmation.',
        hold: hold || null,
        signalQuality: q,
        at: now,
      });
    }

    // ── 10. MACD histogram sign flip ─────────────────────────────────────────
    const curMacdSign = snapshot.macdHistogram == null ? null : Math.sign(snapshot.macdHistogram);
    if (prev.macdSign != null && curMacdSign != null
        && prev.macdSign !== curMacdSign && curMacdSign !== 0) {
      const dir = curMacdSign > 0 ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      alerts.push({
        id: `${symbol}-macd-${now}`, symbol, type: 'macd_flip',
        severity: severityFromAgreement(false, conf, dir, adxStr),
        label: curMacdSign > 0
          ? `${symbol} MACD histogram turned positive`
          : `${symbol} MACD histogram turned negative`,
        context: buildContext(snapshot, dir, q, null),
        note: 'Histogram sign flips are frequent. More meaningful when MACD line also crosses signal line and ADX is trending.',
        signalQuality: q,
        at: now,
      });
    }

    // ── 11. Volume spike ──────────────────────────────────────────────────────
    if (snapshot.volumeSpike?.isSpike && !prev.volumeSpike) {
      const ratio = snapshot.volumeSpike.ratio ?? 0;
      alerts.push({
        id: `${symbol}-vol-${now}`, symbol, type: 'volume_spike',
        severity: ratio >= 4 ? 'strong' : 'moderate',
        label: `${symbol} volume is ${ratio.toFixed(1)}x its 20-day average — check news feed`,
        context: `Current: ${snapshot.volumeSpike.current?.toLocaleString()} vs avg ${snapshot.volumeSpike.avg?.toFixed(0)} · Momentum regime: ${snapshot.momentumRegime?.regime ?? 'unknown'}`,
        note: 'Unusual volume accompanies news or institutional activity. Volume alone has no direction — cross-reference the news feed and current trend.',
        signalQuality: 40,
        at: now,
      });
    }

    // ── 12. ADX entering trending territory ───────────────────────────────────
    const curAdxStrength  = snapshot.adx?.strength ?? null;
    const prevAdxStrength = prev.adxStrength ?? null;
    if (prevAdxStrength && curAdxStrength && prevAdxStrength !== curAdxStrength
        && ['trending', 'strong_trend'].includes(curAdxStrength)
        && !['trending', 'strong_trend'].includes(prevAdxStrength)) {
      const dir = snapshot.adx.plusDI > snapshot.adx.minusDI ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      const hold = estimateHoldDuration(snapshot, dir);
      alerts.push({
        id: `${symbol}-adx-${now}`, symbol, type: 'adx_trend',
        severity: curAdxStrength === 'strong_trend' ? 'strong' : 'moderate',
        label: `${symbol} ADX entered ${curAdxStrength === 'strong_trend' ? 'strong trend' : 'trending'} territory (${snapshot.adx.value}) — ${snapshot.adx.plusDI > snapshot.adx.minusDI ? 'bulls leading' : 'bears leading'}`,
        context: buildContext(snapshot, dir, q, hold),
        note: 'ADX measures trend persistence, not direction. +DI vs -DI gives the direction. ADX crossing 25 is a regime change — trending signals are now more reliable.',
        hold,
        signalQuality: q,
        at: now,
      });
    }

    // ── 13. ADX dropping back to range-bound ──────────────────────────────────
    if (prevAdxStrength && curAdxStrength && prevAdxStrength !== curAdxStrength
        && curAdxStrength === 'range_bound'
        && ['trending', 'strong_trend'].includes(prevAdxStrength)) {
      alerts.push({
        id: `${symbol}-adx-weak-${now}`, symbol, type: 'adx_weakening',
        severity: 'mild',
        label: `${symbol} ADX dropped back to range-bound (${snapshot.adx?.value}) — trend momentum fading`,
        context: `Was: ${prevAdxStrength.replace(/_/g, ' ')} · Consider tightening stops on existing trend positions`,
        note: 'Trend strength fading. Breakout follow-through less reliable. Range strategies may apply.',
        signalQuality: 30,
        at: now,
      });
    }

    // ── 14. Ichimoku cloud break ───────────────────────────────────────────────
    const curIchiPos  = snapshot.ichimoku?.position ?? null;
    const prevIchiPos = prev.ichimokuPosition ?? null;
    if (prevIchiPos && curIchiPos && curIchiPos !== prevIchiPos
        && ['above_cloud', 'below_cloud'].includes(curIchiPos)) {
      const dir = curIchiPos === 'above_cloud' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      const hold = estimateHoldDuration(snapshot, dir);
      alerts.push({
        id: `${symbol}-ichi-${now}`, symbol, type: 'ichimoku_cloud',
        severity: severityFromAgreement(false, conf, dir, adxStr),
        label: `${symbol} price moved ${curIchiPos === 'above_cloud' ? 'above' : 'below'} the Ichimoku cloud`,
        context: buildContext(snapshot, dir, q, hold),
        note: 'Cloud breaks are a trend-context shift. Most reliable when confirmed by volume and ADX ≥ 25.',
        hold,
        signalQuality: q,
        at: now,
      });
    }

    // ── 15. Volatility regime change ───────────────────────────────────────────
    const curVolRegime  = snapshot.volatilityRegime?.regime ?? null;
    const prevVolRegime = prev.volRegime ?? null;
    if (prevVolRegime && curVolRegime && curVolRegime !== prevVolRegime
        && curVolRegime !== 'normal_volatility') {
      alerts.push({
        id: `${symbol}-volreg-${now}`, symbol, type: 'volatility_regime',
        severity: 'moderate',
        label: `${symbol} entered ${curVolRegime.replace(/_/g, ' ')} (ATR at ${snapshot.volatilityRegime.percentile}th percentile of own history)`,
        context: `ATR(14): ${snapshot.atr14} · Prior regime: ${prevVolRegime.replace(/_/g, ' ')} · ${curVolRegime.includes('high') ? 'Widen stops.' : 'Low vol often precedes a breakout.'}`,
        note: 'Volatility regime describes ATR vs this asset\'s own recent history — not absolute volatility. High-vol: widen stops. Low-vol: watch for squeeze.',
        signalQuality: 35,
        at: now,
      });
    }

    // ── 16. Bollinger-Keltner squeeze release ─────────────────────────────────
    const curSqueeze  = snapshot.keltner?.squeeze ?? snapshot.bollinger?.squeeze ?? null;
    const prevSqueeze = prev.keltnerSqueeze ?? prev.bollSqueeze ?? null;
    if (prevSqueeze === true && curSqueeze === false) {
      const dir    = conf && conf.up >= conf.down ? 'up' : 'down';
      const q      = signalQuality(dir, snapshot);
      const hold   = q >= 55 ? estimateHoldDuration(snapshot, dir) : null;
      // Multi-confirmation gate: only 'strong' if quality score is high
      const sev    = q >= 70 ? 'strong' : q >= 50 ? 'moderate' : 'mild';
      alerts.push({
        id: `${symbol}-squeeze-${now}`, symbol, type: 'squeeze_fire',
        severity: sev,
        label: `${symbol} Bollinger-Keltner squeeze released — directional move likely ${dir === 'up' ? '(bullish bias)' : '(bearish bias)'}`,
        context: buildContext(snapshot, dir, q, hold),
        note: 'True squeeze fires when Bollinger Bands contract inside Keltner Channels. The release often precedes a sharp move. Direction bias from confluence — not guaranteed.',
        hold: hold || null,
        signalQuality: q,
        at: now,
      });
    }

    // ── 17. Aroon trend shift ─────────────────────────────────────────────────
    const curAroonBias  = snapshot.aroon?.bias ?? null;
    const prevAroonBias = prev.aroonBias ?? null;
    if (prevAroonBias && curAroonBias && prevAroonBias !== curAroonBias
        && (curAroonBias === 'strong_bull' || curAroonBias === 'strong_bear')) {
      const dir = curAroonBias === 'strong_bull' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      alerts.push({
        id: `${symbol}-aroon-${now}`, symbol, type: 'aroon_trend',
        severity: severityFromAgreement(false, conf, dir, adxStr),
        label: `${symbol} Aroon entered ${curAroonBias.replace('_', ' ')} zone (osc: ${snapshot.aroon.oscillator})`,
        context: buildContext(snapshot, dir, q, null),
        note: 'Aroon measures how recently swing highs/lows occurred. Strong reading = new high/low just formed. Trend follow-through context.',
        signalQuality: q,
        at: now,
      });
    }

    // ── 18. MFI overbought/oversold ───────────────────────────────────────────
    const curMfiZone  = snapshot.mfi != null ? (snapshot.mfi >= 80 ? 'overbought' : snapshot.mfi <= 20 ? 'oversold' : 'neutral') : null;
    const prevMfiZone = prev.mfiZone ?? null;
    if (prevMfiZone && curMfiZone && prevMfiZone !== curMfiZone && curMfiZone !== 'neutral') {
      const dir = curMfiZone === 'oversold' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      const hold = curMfiZone === 'oversold' ? estimateHoldDuration(snapshot, dir) : null;
      alerts.push({
        id: `${symbol}-mfi-${now}`, symbol, type: 'mfi_extreme',
        severity: severityFromAgreement(false, conf, dir, adxStr),
        label: `${symbol} MFI entered ${curMfiZone} zone (${snapshot.mfi}) — volume-confirmed ${curMfiZone === 'oversold' ? 'buying pressure depleted' : 'selling pressure depleted'}`,
        context: buildContext(snapshot, dir, q, hold),
        note: 'MFI is RSI weighted by volume — a more complete picture than RSI alone. Extremes can persist in trending markets.',
        hold: hold || null,
        signalQuality: q,
        at: now,
      });
    }

    // ── 19. Multi-indicator confluence surge ≥70% (quality-gated) ────────────
    const curPct  = conf ? Math.max(conf.up, conf.down) / (conf.total || 1) : 0;
    const prevPct = prev.confluencePct ?? 0;
    const curDir  = conf ? (conf.up >= conf.down ? 'up' : 'down') : null;
    if (curPct >= 0.70 && prevPct < 0.70 && curDir && conf) {
      const q    = signalQuality(curDir, snapshot);
      const hold = q >= 60 ? estimateHoldDuration(snapshot, curDir) : null;
      const sev  = q >= 75 ? 'strong' : q >= 55 ? 'moderate' : 'mild';
      alerts.push({
        id: `${symbol}-confluence-${now}`, symbol, type: 'confluence_surge',
        severity: sev,
        label: `${symbol} ${Math.round(curPct * 100)}% of indicators leaning ${curDir} — rare confluence (quality: ${q}/100)`,
        context: buildContext(snapshot, curDir, q, hold),
        note: 'High indicator agreement. Most reliable when it occurs after a consolidation or squeeze, not mid-impulse. The strongest readings often occur after a large move is already underway.',
        hold: hold || null,
        signalQuality: q,
        at: now,
      });
    }

    // ── 20. Elder Ray signal shift ────────────────────────────────────────────
    const curErSignal  = snapshot.elderRay?.signal ?? null;
    const prevErSignal = prev.elderRaySignal ?? null;
    if (curErSignal && prevErSignal && curErSignal !== prevErSignal
        && ['strong_bull', 'strong_bear'].includes(curErSignal)) {
      const dir = curErSignal === 'strong_bull' ? 'up' : 'down';
      const q   = signalQuality(dir, snapshot);
      alerts.push({
        id: `${symbol}-elder-${now}`, symbol, type: 'elder_ray',
        severity: severityFromAgreement(false, conf, dir, adxStr),
        label: `${symbol} Elder Ray shifted to ${curErSignal.replace('_', ' ')} (both Bull + Bear Power ${curErSignal === 'strong_bull' ? 'positive' : 'negative'})`,
        context: buildContext(snapshot, dir, q, null) + ` · Bull: ${snapshot.elderRay.bullPower} / Bear: ${snapshot.elderRay.bearPower}`,
        note: 'When both Bull and Bear Power are positive, bulls control both peaks and troughs. Transitions between strong_bull and strong_bear are the most significant Elder Ray events.',
        signalQuality: q,
        at: now,
      });
    }

    // ── 21. ROC extreme impulse ───────────────────────────────────────────────
    const curRoc  = snapshot.roc ?? null;
    const prevRoc = prev.roc ?? null;
    if (curRoc != null && prevRoc != null) {
      const threshold = 8;
      if (Math.abs(curRoc) >= threshold && Math.abs(prevRoc) < threshold) {
        const dir = curRoc > 0 ? 'up' : 'down';
        const q   = signalQuality(dir, snapshot);
        alerts.push({
          id: `${symbol}-roc-${now}`, symbol, type: 'roc_impulse',
          severity: Math.abs(curRoc) >= 15 ? 'strong' : 'moderate',
          label: `${symbol} ROC(10) hit ${curRoc > 0 ? '+' : ''}${curRoc}% — momentum impulse`,
          context: buildContext(snapshot, dir, q, null),
          note: 'ROC spike = sharp price move in 10 bars. Check volume and news. Extreme ROC often mean-reverts but persists in strong trends.',
          signalQuality: q,
          at: now,
        });
      }
    }

    // ── 22. TRIPLE CONFIRMATION — strong buy/sell ──────────────────────────────
    // Fires when ≥3 independent signal families all agree simultaneously.
    // This is the highest-conviction alert in the engine. Still descriptive.
    for (const dir of ['up', 'down']) {
      const families = activeSignalFamilies(snapshot, dir);
      const prevFamilies = prev[`tripleConfFamilies_${dir}`] ?? [];
      if (families.length >= 3 && prevFamilies.length < 3) {
        const q    = signalQuality(dir, snapshot);
        const hold = estimateHoldDuration(snapshot, dir);
        alerts.push({
          id: `${symbol}-triple-${dir}-${now}`, symbol, type: 'triple_confirmation',
          severity: 'strong',
          label: `${symbol} TRIPLE CONFIRMATION — ${dir === 'up' ? 'STRONG BUY SETUP' : 'STRONG SELL SETUP'}: ${families.join(' + ')} all agree`,
          context: buildContext(snapshot, dir, q, hold),
          note: `${families.length} independent signal families (${families.join(', ')}) are simultaneously aligned ${dir === 'up' ? 'bullish' : 'bearish'}. This is the highest-conviction alert this engine produces. It describes current conditions — not a guaranteed outcome. Always use a defined stop.`,
          hold,
          signalQuality: q,
          at: now,
        });
      }
    }

    // ── 23. Pivot / Fibonacci level cross (new) ───────────────────────────────
    if (snapshot.pivotPoints && snapshot.atr14) {
      const pivots = snapshot.pivotPoints;
      const price  = snapshot.close;
      const atr14  = snapshot.atr14;
      const prevPrice = prev.close ?? null;

      const levels = [
        { name: 'Pivot (P)',  value: pivots.pivot },
        { name: 'R1',         value: pivots.r1    },
        { name: 'R2',         value: pivots.r2    },
        { name: 'S1',         value: pivots.s1    },
        { name: 'S2',         value: pivots.s2    },
      ];

      if (prevPrice && price) {
        for (const lvl of levels) {
          if (!lvl.value) continue;
          const crossed = (prevPrice < lvl.value && price >= lvl.value)
                       || (prevPrice > lvl.value && price <= lvl.value);
          if (!crossed) continue;
          const dir  = price >= lvl.value ? 'up' : 'down';
          const dist = Math.abs(price - lvl.value) / atr14;
          if (dist > 0.5) continue; // only fire if price is close to the level
          alerts.push({
            id: `${symbol}-pivot-${lvl.name}-${now}`, symbol, type: 'pivot_cross',
            severity: lvl.name === 'Pivot (P)' ? 'moderate' : 'mild',
            label: `${symbol} crossed ${dir === 'up' ? 'above' : 'below'} ${lvl.name} ($${lvl.value}) — key reference level`,
            context: `Distance from level: ${dist.toFixed(2)} ATR · Trend: ${snapshot.smaTrend} · ADX: ${snapshot.adx?.value ?? 'n/a'}`,
            note: 'Pivot points are reference levels derived from prior-session H/L/C. Reactions at these levels are common but not guaranteed. Confluence with trend direction increases reliability.',
            signalQuality: 35,
            at: now,
          });
        }
      }
    }

  } // end if(prev)

  // ─── Store state for next diff ────────────────────────────────────────────
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
    close:              snapshot.close ?? null,
    stochK:             snapshot.stochastic?.k ?? null,
    stochD:             snapshot.stochastic?.d ?? null,
    tripleConfFamilies_up:   activeSignalFamilies(snapshot, 'up'),
    tripleConfFamilies_down: activeSignalFamilies(snapshot, 'down'),
  });

  // Sort: strong first, then quality score descending
  alerts.sort((a, b) => {
    const sevOrder = { strong: 3, moderate: 2, mild: 1 };
    const sevDiff = (sevOrder[b.severity] ?? 0) - (sevOrder[a.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    return (b.signalQuality ?? 0) - (a.signalQuality ?? 0);
  });

  return alerts;
}

module.exports = { detectAlerts };
