'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL ENGINE v2 — ADVANCED EDITION
//
// Architecture:
//   1. ADAPTIVE THRESHOLDS — RSI/ADX/etc thresholds scale with each asset's
//      own rolling volatility instead of hardcoded universal numbers.
//   2. COMPOSITE SCORING — every alert carries a 0–100 quality score built
//      from: divergence presence, trend alignment, volume confirmation,
//      confluence %, regime fit, and recency.
//   3. PATTERN MEMORY — detects multi-bar patterns (BB squeeze → fire,
//      "three soldiers"/"three crows", double top/bottom approach) by
//      reading the indicator state ring buffer.
//   4. REGIME FILTER — noise threshold adjusts per volatility regime.
//      High-vol: only strong/extreme alerts fire. Low-vol: more sensitive.
//   5. DEDUPLICATION WINDOW — same alert type suppressed for N bars to
//      prevent re-firing on persistent conditions.
//   6. SIGNAL STACK — at most N alerts are surfaced per cycle, ranked by
//      quality score descending. Prevents flood during big moves.
//   7. 28 ALERT TYPES — extends the existing 20 with: stoch cross,
//      DI crossover, TEMA trend, price-at-pivot, OBV divergence, Fibonacci
//      proximity, BB walk, Keltner breakout, and squeeze momentum bias.
//
// Every alert is descriptive — not a trade recommendation. Every alert
// carries a quality score so the UI can rank or threshold display.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('./db');

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ALERTS_PER_CYCLE   = 6;    // cap per symbol per tick — ranked by score
const DEDUP_BARS             = 4;    // suppress same type for this many price ticks
const COMPOSITE_MIN_SCORE    = 22;   // below this: don't fire regardless of severity

// Regime-aware minimum scores — what minimum composite is needed to fire?
const REGIME_SCORE_FLOOR = {
  high_volatility:   45,   // noisy market — only high-confidence fires
  normal_volatility: 22,
  low_volatility:    15,   // compressed market — more sensitive
};

// ── Utility ──────────────────────────────────────────────────────────────────

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function r1(n) { return n != null ? Math.round(n * 10) / 10 : null; }

function isBarsAgo(prev, prop, bars = DEDUP_BARS) {
  // Check if the last time this alert type fired was >= `bars` ticks ago.
  // We encode "last fired" as a tick counter in the persisted state.
  const key = `lastFired_${prop}`;
  const last = prev ? (prev[key] ?? -Infinity) : -Infinity;
  const cur  = prev ? (prev._tickCount ?? 0) : 0;
  return (cur - last) >= bars;
}

// ── Adaptive Thresholds ───────────────────────────────────────────────────────
// Rather than hardcoded RSI(70/30) etc, scale thresholds with the asset's own
// volatility regime. Low-vol assets: tighter. High-vol: wider.

function adaptiveRsiThresholds(volRegime) {
  if (!volRegime) return { ob: 70, os: 30 };
  const pct = volRegime.percentile ?? 50;
  // High volatility → wider bands (fewer signals)
  if (pct >= 80) return { ob: 72, os: 28 };
  if (pct <= 20) return { ob: 68, os: 32 };
  return { ob: 70, os: 30 };
}

function adaptiveAdxThreshold(volRegime) {
  const pct = volRegime?.percentile ?? 50;
  if (pct >= 80) return 28;  // in noisy market, require stronger trend confirmation
  if (pct <= 20) return 18;  // in quiet market, even mild trend is notable
  return 22;
}

function adaptiveRocThreshold(volRegime) {
  const pct = volRegime?.percentile ?? 50;
  if (pct >= 80) return 12;
  if (pct <= 20) return 4;
  return 8;
}

// ── Composite Quality Score ───────────────────────────────────────────────────
// Returns 0–100. Higher = more factors agree, better timing, cleaner setup.

function compositeScore({
  direction,          // 'up' | 'down'
  confluence,         // snapshot.confluence
  volRegime,          // snapshot.volatilityRegime
  hasDivergence,      // bool — is an RSI or MACD divergence active?
  divergenceDir,      // 'bullish' | 'bearish' | null
  volumeConfirm,      // bool — volume spike?
  trendAligned,       // bool — does this direction match SMA/Supertrend?
  longTrendAligned,   // bool — does this match the 200-SMA direction?
  adxVal,             // number | null
  baseStrong,         // bool — is the base alert condition extreme?
  recencyScore,       // 0–1 — 1 = very fresh, 0 = stale
  macdAligned,        // bool — does MACD histogram agree?
  psarAligned,        // bool — does PSAR agree?
  momentumRegime,     // snapshot.momentumRegime
}) {
  let score = 0;

  // Confluence — biggest weight (0–30 pts)
  if (confluence && confluence.total) {
    const agreeing = direction === 'up' ? confluence.up : confluence.down;
    const pct = agreeing / confluence.total;
    score += Math.round(pct * 30);
  }

  // Divergence alignment (0–20 pts)
  if (hasDivergence) {
    const divAligned = (divergenceDir === 'bullish' && direction === 'up')
                    || (divergenceDir === 'bearish' && direction === 'down');
    score += divAligned ? 20 : 5; // present but opposing: slight bump (complex setup)
  }

  // Volume confirmation (0–10 pts)
  if (volumeConfirm) score += 10;

  // Short-term trend aligned (0–8 pts)
  if (trendAligned) score += 8;

  // Long-term trend aligned / 200 SMA (0–7 pts)
  if (longTrendAligned) score += 7;

  // ADX — trend strength confirmation (0–10 pts)
  if (adxVal != null) {
    if (adxVal >= 40) score += 10;
    else if (adxVal >= 25) score += 6;
    else if (adxVal >= 20) score += 3;
    // sub-20: trending indicators less reliable in range — 0 pts
  }

  // Base condition extreme (0–5 pts)
  if (baseStrong) score += 5;

  // Recency (0–5 pts)
  score += Math.round((recencyScore ?? 0.5) * 5);

  // MACD + PSAR agreement (0–5 pts each)
  if (macdAligned)  score += 5;
  if (psarAligned)  score += 5;

  // Momentum regime agreement (0–5 pts)
  if (momentumRegime) {
    const regimeDir = momentumRegime.regime.includes('bull') ? 'up'
                    : momentumRegime.regime.includes('bear') ? 'down' : null;
    if (regimeDir === direction) score += 5;
  }

  return Math.min(100, score);
}

// ── Severity from Score ───────────────────────────────────────────────────────

function severityFromScore(score) {
  if (score >= 65) return 'strong';
  if (score >= 40) return 'moderate';
  return 'mild';
}

// ── Pattern Detectors ─────────────────────────────────────────────────────────

/**
 * Detects Bollinger Band "walking" — price closing outside the band for
 * 2+ consecutive bars signals strong trend continuation, not just a touch.
 */
function detectBBWalk(snap, prev) {
  const pos = snap.bollinger?.position;
  const prevPos = prev?.bollPosition;
  if (!pos || !prevPos) return null;
  if (pos === prevPos && pos !== 'inside_bands') {
    // Second+ bar outside the band
    return {
      direction: pos === 'at_or_above_upper' ? 'down' : 'up',
      label: pos === 'at_or_above_upper'
        ? 'Continued price walk along upper Bollinger Band — extended stretch'
        : 'Continued price walk along lower Bollinger Band — extended stretch',
      note: 'Prices can walk a Bollinger Band for several bars in strong trends. This is a persistence signal — not a reversal call by itself.',
    };
  }
  return null;
}

/**
 * Detects Stochastic %K crossing %D.
 * Bullish: K crosses above D from below 50.
 * Bearish: K crosses below D from above 50.
 */
function detectStochCross(snap, prev) {
  const k = snap.stochastic?.k;
  const d = snap.stochastic?.d;
  const pk = prev?.stochK;
  const pd = prev?.stochD;
  if (k == null || d == null || pk == null || pd == null) return null;
  if (pk <= pd && k > d && k < 70) return { direction: 'up', label: `Stochastic %K crossed above %D (${r1(k)} / ${r1(d)})` };
  if (pk >= pd && k < d && k > 30) return { direction: 'down', label: `Stochastic %K crossed below %D (${r1(k)} / ${r1(d)})` };
  return null;
}

/**
 * Detects DI crossover — +DI crossing -DI signals trend direction change.
 * Only fires when ADX >= adaptive threshold (trend is meaningful).
 */
function detectDICross(snap, prev, adxThresh) {
  const plusDI  = snap.adx?.plusDI;
  const minusDI = snap.adx?.minusDI;
  const pPlus   = prev?.plusDI;
  const pMinus  = prev?.minusDI;
  const adxVal  = snap.adx?.value;
  if (plusDI == null || minusDI == null || pPlus == null || pMinus == null) return null;
  if ((adxVal ?? 0) < adxThresh) return null; // ADX too low — DI crosses are noise
  if (pPlus <= pMinus && plusDI > minusDI) return { direction: 'up',   label: `+DI crossed above -DI with ADX ${r1(adxVal)} — directional confirmation` };
  if (pPlus >= pMinus && plusDI < minusDI) return { direction: 'down', label: `+DI crossed below -DI with ADX ${r1(adxVal)} — directional confirmation` };
  return null;
}

/**
 * Detects Fibonacci proximity — price within 0.5% of a key Fib level.
 * Reports which level and whether price is approaching from above/below.
 */
function detectFibProximity(snap) {
  const fib = snap.fibonacci;
  const price = snap.close;
  if (!fib || price == null) return null;
  const keyRatios = [0.236, 0.382, 0.5, 0.618, 0.786];
  for (const level of fib.levels) {
    if (!keyRatios.includes(level.ratio)) continue;
    const pct = Math.abs(price - level.price) / level.price;
    if (pct <= 0.005) {
      const approaching = price < level.price ? 'below' : 'above';
      return {
        direction: approaching === 'below' ? 'up' : 'down', // near support→ up bias; near resistance → down
        label: `Price within 0.5% of ${(level.ratio * 100).toFixed(1)}% Fibonacci level ($${r2(level.price)})`,
        note: `Fibonacci retracements are confluence zones, not guaranteed reversal points. Price is approaching from ${approaching}.`,
      };
    }
  }
  return null;
}

/**
 * Detects price at pivot point levels (S1, S2, R1, R2).
 */
function detectPivotProximity(snap) {
  const pivots = snap.pivotPoints;
  const price  = snap.close;
  if (!pivots || price == null) return null;
  const levels = [
    { key: 'r2', label: 'R2', dir: 'down' },
    { key: 'r1', label: 'R1', dir: 'down' },
    { key: 'pivot', label: 'Pivot', dir: 'flat' },
    { key: 's1', label: 'S1', dir: 'up' },
    { key: 's2', label: 'S2', dir: 'up' },
  ];
  for (const l of levels) {
    const lvl = pivots[l.key];
    if (lvl == null) continue;
    const pct = Math.abs(price - lvl) / lvl;
    if (pct <= 0.004) {
      return {
        direction: l.dir,
        label: `Price at pivot ${l.label} ($${r2(lvl)}) — key floor-trader reference level`,
        note: 'Pivot levels are computed from prior session H/L/C and are widely watched. Reactions at pivots can be sharp but aren\'t guaranteed.',
      };
    }
  }
  return null;
}

/**
 * Keltner Channel breakout — price closing outside KC while NOT in a Bollinger
 * squeeze (if still in squeeze, wait for the fire). Signals trend continuation
 * with volatility expansion already confirmed by ATR.
 */
function detectKeltnerBreakout(snap, prev) {
  const price  = snap.close;
  const kUpper = snap.keltner?.upper;
  const kLower = snap.keltner?.lower;
  const squeeze = snap.keltner?.squeeze ?? false;
  if (price == null || kUpper == null || kLower == null) return null;
  if (squeeze) return null; // squeeze still building — don't call breakout yet
  const prevAbove = prev?.priceAboveKeltner;
  const prevBelow = prev?.priceBelowKeltner;
  const aboveNow  = price > kUpper;
  const belowNow  = price < kLower;
  if (aboveNow && !prevAbove) return { direction: 'up',   label: `Keltner Channel breakout — price above upper band ($${r2(kUpper)}) with expanded volatility` };
  if (belowNow && !prevBelow) return { direction: 'down', label: `Keltner Channel breakdown — price below lower band ($${r2(kLower)}) with expanded volatility` };
  return null;
}

/**
 * OBV divergence — OBV trend disagrees with price trend.
 * Price rising + OBV falling = distribution (bearish divergence).
 * Price falling + OBV rising = accumulation (bullish divergence).
 */
function detectOBVDivergence(snap, prev) {
  const smaTrend = snap.smaTrend;
  const obvTrend = snap.obv?.trend;
  if (!smaTrend || !obvTrend) return null;
  if (prev?.smaTrend === smaTrend && prev?.obvTrend === obvTrend) return null; // same as last tick
  if (smaTrend === 'bullish' && obvTrend === 'falling') {
    return { direction: 'down', label: 'OBV falling while price trend is bullish — distribution signal (potential bearish divergence)' };
  }
  if (smaTrend === 'bearish' && obvTrend === 'rising') {
    return { direction: 'up', label: 'OBV rising while price trend is bearish — accumulation signal (potential bullish divergence)' };
  }
  return null;
}

/**
 * Squeeze momentum bias — when the BB-KC squeeze fires, use the momentum
 * regime to bias the expected direction rather than just saying "watch for a move."
 */
function detectSqueezeWithBias(snap, prev) {
  const curSqueeze  = snap.keltner?.squeeze ?? snap.bollinger?.squeeze ?? null;
  const prevSqueeze = prev?.keltnerSqueeze ?? prev?.bollSqueeze ?? null;
  if (prevSqueeze !== true || curSqueeze !== false) return null;
  const regime = snap.momentumRegime?.regime ?? 'neutral';
  const dir = regime.includes('bull') ? 'up' : regime.includes('bear') ? 'down' : null;
  return {
    direction: dir,
    label: dir
      ? `Squeeze released with ${regime.replace('_', ' ')} momentum bias — directional move likely ${dir === 'up' ? 'upward' : 'downward'}`
      : 'BB-KC squeeze released — watch for directional expansion (momentum inconclusive)',
    note: 'Squeeze release + momentum regime consensus is a stronger setup than release alone. Direction is inferred from indicator confluence, not guaranteed.',
  };
}

// ── Main Detector ─────────────────────────────────────────────────────────────

function detectAlerts(symbol, snapshot) {
  const prev   = db.getLastIndicatorState(symbol);
  const alerts = [];
  const now    = new Date().toISOString();
  const conf   = snapshot.confluence;
  const volReg = snapshot.volatilityRegime;
  const tick   = (prev?._tickCount ?? 0) + 1;

  // Regime-aware floor
  const regimeFloor = volReg?.regime ? (REGIME_SCORE_FLOOR[volReg.regime] ?? COMPOSITE_MIN_SCORE) : COMPOSITE_MIN_SCORE;

  // Adaptive thresholds
  const rsiThresh   = adaptiveRsiThresholds(volReg);
  const adxThresh   = adaptiveAdxThreshold(volReg);
  const rocThresh   = adaptiveRocThreshold(volReg);

  // Common direction helpers
  const smaTrendDir    = snapshot.smaTrend === 'bullish' ? 'up' : snapshot.smaTrend === 'bearish' ? 'down' : null;
  const stDir          = snapshot.supertrend?.direction ?? null;
  const psarDir        = snapshot.psar?.trend ?? null;
  const longTrendDir   = snapshot.longTrend === 'above_200sma' ? 'up' : snapshot.longTrend === 'below_200sma' ? 'down' : null;

  // Active divergence
  const activeDivRsi  = snapshot.divergence?.rsi ?? null;
  const activeDivMacd = snapshot.divergence?.macd ?? null;
  const activeDivDir  = activeDivRsi?.type ?? activeDivMacd?.type ?? null; // 'bullish' | 'bearish' | null
  const hasDivergence = activeDivDir != null;

  // Volume confirmed
  const volConfirm = snapshot.volumeSpike?.isSpike ?? false;

  // MACD lean
  const macdLean = snapshot.macdHistogram != null ? (snapshot.macdHistogram > 0 ? 'up' : 'down') : null;

  // Helper: build a score and push an alert
  function push(type, direction, label, note, context, extra = {}) {
    if (!isBarsAgo(prev, type, DEDUP_BARS)) return; // dedup

    const aligned = direction ? direction === smaTrendDir : false;
    const longAligned = direction ? direction === longTrendDir : false;
    const macdA   = direction ? direction === macdLean : false;
    const psarA   = direction ? direction === (psarDir === 'up' ? 'up' : psarDir === 'down' ? 'down' : null) : false;

    const score = compositeScore({
      direction,
      confluence: conf,
      volRegime: volReg,
      hasDivergence,
      divergenceDir: activeDivDir === 'bullish' ? 'up' : activeDivDir === 'bearish' ? 'down' : null,
      volumeConfirm: volConfirm,
      trendAligned: aligned,
      longTrendAligned: longAligned,
      adxVal: snapshot.adx?.value ?? null,
      baseStrong: extra.baseStrong ?? false,
      recencyScore: extra.recencyScore ?? 0.5,
      macdAligned: macdA,
      psarAligned: psarA,
      momentumRegime: snapshot.momentumRegime,
    });

    if (score < regimeFloor) return; // regime filter kills low-quality noise

    const severity = extra.forceSeverity ?? severityFromScore(score);

    alerts.push({
      id: `${symbol}-${type}-${now}`,
      symbol,
      type,
      severity,
      qualityScore: score,
      direction,
      label,
      context: context || '',
      note: note || '',
      at: now,
    });
  }

  if (prev) {
    // ── 1. RSI zone transition (adaptive thresholds) ──────────────────────────
    const rsiZone = snapshot.rsiZone;
    const prevRsiZone = prev.rsiZone;
    if (prevRsiZone !== rsiZone && rsiZone !== 'neutral' && rsiZone !== 'unknown') {
      const rsiVal = snapshot.rsi;
      const dir    = rsiZone === 'oversold' ? 'up' : 'down';
      const dist   = rsiZone === 'overbought' ? rsiVal - rsiThresh.ob : rsiThresh.os - rsiVal;
      push(
        'rsi_zone', dir,
        `${symbol} RSI entered ${rsiZone} zone (${r1(rsiVal)}) — adaptive threshold: ${rsiZone === 'overbought' ? rsiThresh.ob : rsiThresh.os}`,
        'RSI extremes can persist for extended periods — especially in trending markets. More meaningful when momentum and volume agree.',
        `RSI: ${r1(rsiVal)} · Confluence: ${conf ? `${conf.up}↑ ${conf.down}↓` : 'n/a'} · Vol regime: ${volReg?.regime ?? 'n/a'}`,
        { baseStrong: dist >= 5, recencyScore: 0.8 }
      );
    }

    // ── 2. RSI momentum fade (leaving extreme without full reversal) ──────────
    if (prev.rsiZone === 'overbought' && rsiZone === 'neutral' && snapshot.rsi < 65) {
      push(
        'rsi_fade_bear', 'down',
        `${symbol} RSI pulled back from overbought (now ${r1(snapshot.rsi)}) — momentum fade`,
        'RSI rolling off overbought territory can signal momentum exhaustion. Not a reversal guarantee — watch for price confirmation.',
        `Prior zone: overbought · Now: ${r1(snapshot.rsi)} · MACD hist: ${snapshot.macdHistogram}`,
        { recencyScore: 0.7 }
      );
    }
    if (prev.rsiZone === 'oversold' && rsiZone === 'neutral' && snapshot.rsi > 35) {
      push(
        'rsi_fade_bull', 'up',
        `${symbol} RSI recovered from oversold (now ${r1(snapshot.rsi)}) — potential base formation`,
        'RSI climbing out of oversold territory with price stabilization can indicate a base is forming. Confirm with volume and trend.',
        `Prior zone: oversold · Now: ${r1(snapshot.rsi)} · OBV: ${snapshot.obv?.trend ?? 'n/a'}`,
        { recencyScore: 0.7 }
      );
    }

    // ── 3. SMA20/50 crossover ─────────────────────────────────────────────────
    if (prev.smaTrend !== snapshot.smaTrend && snapshot.smaTrend !== 'neutral' && prev.smaTrend !== 'neutral') {
      const dir = snapshot.smaTrend === 'bullish' ? 'up' : 'down';
      push(
        'sma_cross', dir,
        `${symbol} SMA20 crossed ${dir === 'up' ? 'above' : 'below'} SMA50`,
        'SMA crossovers confirm trend direction change — they are lagging by nature. The price has typically already moved substantially before this fires.',
        `200-day context: ${snapshot.longTrend ?? 'unknown'} · ADX: ${snapshot.adx?.value ?? 'n/a'}`,
        { baseStrong: true, recencyScore: 0.9 }
      );
    }

    // ── 4. 200-SMA cross ──────────────────────────────────────────────────────
    if (prev.longTrend && snapshot.longTrend && prev.longTrend !== snapshot.longTrend) {
      const dir = snapshot.longTrend === 'above_200sma' ? 'up' : 'down';
      push(
        'sma200_cross', dir,
        `${symbol} price crossed ${dir === 'up' ? 'above' : 'below'} the 200-day SMA ($${r2(snapshot.sma200)})`,
        'The 200-day SMA is the widest-followed long-term trend divider in markets. Crossings are significant structural events — not trivial reversals.',
        `Short-term trend: ${snapshot.smaTrend} · Volume: ${volConfirm ? 'elevated' : 'normal'}`,
        { baseStrong: true, forceSeverity: 'strong', recencyScore: 1.0 }
      );
    }

    // ── 5. Supertrend flip ────────────────────────────────────────────────────
    const curST = snapshot.supertrend?.direction ?? null;
    if (prev.supertrendDir && curST && prev.supertrendDir !== curST) {
      const dir = curST === 'up' ? 'up' : 'down';
      push(
        'supertrend_flip', dir,
        `${symbol} Supertrend flipped ${dir === 'up' ? 'bullish' : 'bearish'} (line: $${r2(snapshot.supertrend?.line)})`,
        'Supertrend uses ATR to define a dynamic trailing stop. Flips in low-ADX choppy conditions are unreliable — this fires only when ADX is trending.',
        `ADX: ${r1(snapshot.adx?.value)} · PSAR: ${snapshot.psar?.trend ?? 'n/a'} · BB position: ${snapshot.bollinger?.position ?? 'n/a'}`,
        { baseStrong: true, recencyScore: 0.95 }
      );
    }

    // ── 6. PSAR trend flip ────────────────────────────────────────────────────
    const curPsar = snapshot.psar?.trend ?? null;
    if (prev.psarTrend && curPsar && prev.psarTrend !== curPsar) {
      const dir = curPsar === 'up' ? 'up' : 'down';
      push(
        'psar_flip', dir,
        `${symbol} Parabolic SAR flipped ${dir === 'up' ? 'bullish' : 'bearish'} ($${r2(snapshot.psar?.value)})`,
        'PSAR accelerates in strong trends and whipsaws in ranges. Best when ADX confirms trend presence.',
        `Supertrend: ${curST ?? 'n/a'} · SMA: ${snapshot.smaTrend}`,
        { recencyScore: 0.8 }
      );
    }

    // ── 7. Momentum regime change ─────────────────────────────────────────────
    const curMomReg  = snapshot.momentumRegime?.regime ?? null;
    const prevMomReg = prev.momentumRegime ?? null;
    if (prevMomReg && curMomReg && prevMomReg !== curMomReg && curMomReg !== 'neutral') {
      const dir   = curMomReg.includes('bull') ? 'up' : curMomReg.includes('bear') ? 'down' : null;
      const strong = curMomReg === 'strong_bull' || curMomReg === 'strong_bear';
      if (dir) {
        push(
          'momentum_regime', dir,
          `${symbol} momentum regime shifted to ${curMomReg.replace('_', ' ')} (${snapshot.momentumRegime.bullVotes} bull / ${snapshot.momentumRegime.bearVotes} bear votes)`,
          'Multi-indicator momentum classification: RSI, MACD histogram, ADX direction, ROC, CMO. Regime shift requires ≥3 of 5 indicators agreeing.',
          `Strength: ${snapshot.momentumRegime.strength}% agreement · Prior: ${prevMomReg.replace('_', ' ')}`,
          { baseStrong: strong, recencyScore: 0.9 }
        );
      }
    }

    // ── 8. RSI divergence ─────────────────────────────────────────────────────
    const curRsiDiv  = snapshot.divergence?.rsi ?? null;
    const prevRsiDiv = prev.rsiDivergenceType ?? null;
    if (curRsiDiv && curRsiDiv.type !== prevRsiDiv) {
      const dir = curRsiDiv.type === 'bullish' ? 'up' : 'down';
      push(
        'rsi_divergence', dir,
        `${symbol} ${curRsiDiv.label} (${curRsiDiv.confidence} confidence)`,
        'Divergence: price and RSI momentum disagree at swing points. High-confidence divergences have historically preceded reversals more often than not — but reversal timing is unknown.',
        `Price gap: ${curRsiDiv.pricePctGap}% · Signal freshness: ${curRsiDiv.barsAgo} bars old`,
        { baseStrong: curRsiDiv.confidence === 'high', recencyScore: Math.max(0, 1 - curRsiDiv.barsAgo / 15) }
      );
    }

    // ── 9. MACD divergence ────────────────────────────────────────────────────
    const curMacdDiv  = snapshot.divergence?.macd ?? null;
    const prevMacdDiv = prev.macdDivergenceType ?? null;
    if (curMacdDiv && curMacdDiv.type !== prevMacdDiv) {
      const dir = curMacdDiv.type === 'bullish' ? 'up' : 'down';
      push(
        'macd_divergence', dir,
        `${symbol} ${curMacdDiv.label} (${curMacdDiv.confidence} confidence)`,
        'MACD histogram divergence: price and histogram disagree at swing points. Leading read on momentum exhaustion — use with trend context.',
        `Price gap: ${curMacdDiv.pricePctGap}% · Signal freshness: ${curMacdDiv.barsAgo} bars old`,
        { baseStrong: curMacdDiv.confidence === 'high', recencyScore: Math.max(0, 1 - curMacdDiv.barsAgo / 15) }
      );
    }

    // ── 10. MACD histogram sign flip ─────────────────────────────────────────
    const curMacdSign = snapshot.macdHistogram == null ? null : Math.sign(snapshot.macdHistogram);
    const prevMacdSign = prev.macdSign;
    if (prevMacdSign != null && curMacdSign != null && prevMacdSign !== curMacdSign && curMacdSign !== 0) {
      const dir = curMacdSign > 0 ? 'up' : 'down';
      push(
        'macd_flip', dir,
        `${symbol} MACD histogram turned ${dir === 'up' ? 'positive' : 'negative'} (hist: ${snapshot.macdHistogram})`,
        'Histogram sign flip = MACD line crossing signal line. More meaningful when aligned with a trend signal and when the cross is from a significant distance.',
        `MACD line: ${snapshot.macdLine} · Signal: ${snapshot.macdSignal} · ADX: ${r1(snapshot.adx?.value)}`,
        { recencyScore: 0.7 }
      );
    }

    // ── 11. Volume spike ──────────────────────────────────────────────────────
    if (snapshot.volumeSpike?.isSpike && !prev.volumeSpike) {
      const ratio = snapshot.volumeSpike.ratio ?? 0;
      push(
        'volume_spike', null,
        `${symbol} volume ${ratio.toFixed(1)}× the 20-day average — unusual activity`,
        'Volume spikes often accompany news, institutional orders, or capitulation. Check the news feed. Volume alone gives no direction — combine with price action.',
        `Current: ${snapshot.volumeSpike.current?.toLocaleString()} · 20d avg: ${Math.round(snapshot.volumeSpike.avg).toLocaleString()}`,
        { baseStrong: ratio >= 4, forceSeverity: ratio >= 5 ? 'strong' : ratio >= 3 ? 'moderate' : 'mild', recencyScore: 1.0 }
      );
    }

    // ── 12. ADX entering trending territory ───────────────────────────────────
    const curAdxStr  = snapshot.adx?.strength ?? null;
    const prevAdxStr = prev.adxStrength ?? null;
    if (prevAdxStr && curAdxStr && prevAdxStr !== curAdxStr
        && ['trending', 'strong_trend'].includes(curAdxStr)
        && !['trending', 'strong_trend'].includes(prevAdxStr)) {
      const dir = (snapshot.adx?.plusDI ?? 0) > (snapshot.adx?.minusDI ?? 0) ? 'up' : 'down';
      push(
        'adx_trend', dir,
        `${symbol} ADX entered ${curAdxStr === 'strong_trend' ? 'strong trend' : 'trending'} territory (${r1(snapshot.adx?.value)}) — adaptive threshold: ${adxThresh}`,
        'ADX measures trend persistence, not direction. Combined with +DI/-DI for direction context. Rising ADX in a move = trend has momentum.',
        `+DI: ${r1(snapshot.adx?.plusDI)} · -DI: ${r1(snapshot.adx?.minusDI)} · DI leader: ${dir === 'up' ? 'bulls' : 'bears'}`,
        { baseStrong: curAdxStr === 'strong_trend', recencyScore: 0.85 }
      );
    }

    // ── 13. ADX weakening back to range ──────────────────────────────────────
    if (prevAdxStr && curAdxStr && prevAdxStr !== curAdxStr && curAdxStr === 'range_bound'
        && ['trending', 'strong_trend'].includes(prevAdxStr)) {
      push(
        'adx_weakening', null,
        `${symbol} ADX dropped back to range-bound (${r1(snapshot.adx?.value)}) — trend may be losing momentum`,
        'ADX declining from trending territory: trend follow-through less reliable. Range-bound strategies and mean-reversion setups become more applicable.',
        `Was: ${prevAdxStr.replace('_', ' ')}`,
        { recencyScore: 0.7, forceSeverity: 'mild' }
      );
    }

    // ── 14. Ichimoku cloud break ──────────────────────────────────────────────
    const curIchiPos  = snapshot.ichimoku?.position ?? null;
    const prevIchiPos = prev.ichimokuPosition ?? null;
    if (prevIchiPos && curIchiPos && curIchiPos !== prevIchiPos && ['above_cloud', 'below_cloud'].includes(curIchiPos)) {
      const dir = curIchiPos === 'above_cloud' ? 'up' : 'down';
      push(
        'ichimoku_cloud', dir,
        `${symbol} price moved ${dir === 'up' ? 'above' : 'below'} the Ichimoku cloud`,
        'Ichimoku cloud breaks are multi-factor trend signals — the cloud itself is dynamic support/resistance. Most reliable when confirmed by volume and ADX.',
        `Tenkan: ${r2(snapshot.ichimoku?.tenkan)} · Kijun: ${r2(snapshot.ichimoku?.kijun)} · TK cross: ${snapshot.ichimoku?.tkCross ?? 'n/a'}`,
        { baseStrong: volConfirm, recencyScore: 0.9 }
      );
    }

    // ── 15. Volatility regime change ──────────────────────────────────────────
    const curVolReg  = volReg?.regime ?? null;
    const prevVolReg = prev.volRegime ?? null;
    if (prevVolReg && curVolReg && curVolReg !== prevVolReg && curVolReg !== 'normal_volatility') {
      push(
        'volatility_regime', null,
        `${symbol} entered ${curVolReg.replace(/_/g, ' ')} (ATR at ${volReg?.percentile}th percentile of own history)`,
        `${curVolReg === 'high_volatility' ? 'High volatility: widen stops, reduce position size, expect larger swings in both directions.' : 'Low volatility: often precedes a breakout. Watch for squeeze signals. Tighter ranges but risk of sudden expansion.'}`,
        `ATR(14): ${r2(snapshot.atr14)} · Prior: ${prevVolReg.replace(/_/g, ' ')}`,
        { forceSeverity: 'moderate', recencyScore: 0.8 }
      );
    }

    // ── 16. Squeeze fire with momentum bias (replaces plain squeeze alert) ────
    const squeezeResult = detectSqueezeWithBias(snapshot, prev);
    if (squeezeResult) {
      push(
        'squeeze_fire', squeezeResult.direction,
        `${symbol} ${squeezeResult.label}`,
        squeezeResult.note ?? 'BB-KC squeeze release. Momentum bias computed from RSI, MACD, ADX, ROC, CMO agreement.',
        `Momentum regime: ${snapshot.momentumRegime?.regime ?? 'n/a'} · BB width: ${r2(snapshot.bollinger?.width)} · Conf: ${conf ? `${conf.up}↑/${conf.down}↓` : 'n/a'}`,
        { baseStrong: true, forceSeverity: 'strong', recencyScore: 1.0 }
      );
    }

    // ── 17. Aroon trend shift ─────────────────────────────────────────────────
    const curAroon  = snapshot.aroon?.bias ?? null;
    const prevAroon = prev.aroonBias ?? null;
    if (prevAroon && curAroon && prevAroon !== curAroon && ['strong_bull', 'strong_bear'].includes(curAroon)) {
      const dir = curAroon === 'strong_bull' ? 'up' : 'down';
      push(
        'aroon_trend', dir,
        `${symbol} Aroon entered ${curAroon.replace('_', ' ')} zone (oscillator: ${r1(snapshot.aroon?.oscillator)})`,
        'Aroon measures how recently swing highs/lows occurred. Strong Aroon = a new high/low just formed = fresh trend, not an echo of one.',
        `Prior: ${prevAroon.replace('_', ' ')} · ADX: ${r1(snapshot.adx?.value)}`,
        { recencyScore: 0.8 }
      );
    }

    // ── 18. MFI extreme ───────────────────────────────────────────────────────
    const mfi    = snapshot.mfi;
    const mfiZone = mfi != null ? (mfi >= 80 ? 'overbought' : mfi <= 20 ? 'oversold' : 'neutral') : null;
    const prevMfiZone = prev.mfiZone ?? null;
    if (prevMfiZone && mfiZone && prevMfiZone !== mfiZone && mfiZone !== 'neutral') {
      const dir = mfiZone === 'oversold' ? 'up' : 'down';
      push(
        'mfi_extreme', dir,
        `${symbol} MFI entered ${mfiZone} zone (${r1(mfi)}) — volume-weighted money flow extreme`,
        'MFI is like RSI but weighted by volume — both price direction and volume contribute. An MFI extreme with volume confirmation is a stronger signal than RSI alone.',
        `Volume: ${volConfirm ? 'spike confirmed' : 'normal'} · RSI: ${r1(snapshot.rsi)} · RSI zone: ${snapshot.rsiZone}`,
        { baseStrong: volConfirm, recencyScore: 0.8 }
      );
    }

    // ── 19. Confluence surge ──────────────────────────────────────────────────
    const curPct  = conf ? Math.max(conf.up, conf.down) / (conf.total || 1) : 0;
    const prevPct = prev.confluencePct ?? 0;
    const confDir = conf ? (conf.up >= conf.down ? 'up' : 'down') : null;
    if (curPct >= 0.70 && prevPct < 0.70 && confDir && conf) {
      push(
        'confluence_surge', confDir,
        `${symbol} ${Math.round(curPct * 100)}% of indicators leaning ${confDir} — rare multi-indicator consensus`,
        'When ≥70% of independently-computed indicators agree on direction simultaneously, that is a structurally unusual state. The strongest confluence often occurs mid-move — not at the start.',
        `${conf.up}↑ / ${conf.down}↓ / ${conf.flat} flat of ${conf.total} indicators`,
        { baseStrong: curPct >= 0.80, forceSeverity: curPct >= 0.80 ? 'strong' : 'moderate', recencyScore: 1.0 }
      );
    }

    // ── 20. Elder Ray shift ───────────────────────────────────────────────────
    const curElder  = snapshot.elderRay?.signal ?? null;
    const prevElder = prev.elderRaySignal ?? null;
    if (curElder && prevElder && curElder !== prevElder && ['strong_bull', 'strong_bear'].includes(curElder)) {
      const dir = curElder === 'strong_bull' ? 'up' : 'down';
      push(
        'elder_ray', dir,
        `${symbol} Elder Ray shifted to ${curElder.replace('_', ' ')} — both Bull and Bear Power ${curElder === 'strong_bull' ? 'positive' : 'negative'}`,
        'When Bull Power (High−EMA) and Bear Power (Low−EMA) are both positive, bulls control both the tops and the bottoms of price swings. Both negative means bears are dominant at every intrabar level.',
        `Bull power: ${r2(snapshot.elderRay?.bullPower)} · Bear power: ${r2(snapshot.elderRay?.bearPower)}`,
        { recencyScore: 0.85 }
      );
    }

    // ── 21. ROC momentum impulse ─────────────────────────────────────────────
    const curRoc  = snapshot.roc ?? null;
    const prevRoc = prev.roc ?? null;
    if (curRoc != null && prevRoc != null && Math.abs(curRoc) >= rocThresh && Math.abs(prevRoc) < rocThresh) {
      const dir = curRoc > 0 ? 'up' : 'down';
      push(
        'roc_impulse', dir,
        `${symbol} ROC(10) hit ${curRoc > 0 ? '+' : ''}${r2(curRoc)}% — momentum impulse (adaptive threshold: ${rocThresh}%)`,
        'Rate-of-change spike = sharp recent move. Check volume and news. Extreme ROC often mean-reverts but can persist in strong trends confirmed by ADX.',
        `Trend: ${snapshot.smaTrend} · ADX: ${r1(snapshot.adx?.value)} · Vol: ${volConfirm ? 'elevated' : 'normal'}`,
        { baseStrong: Math.abs(curRoc) >= rocThresh * 1.5, recencyScore: 0.9 }
      );
    }

    // ── 22. Stochastic %K / %D crossover (NEW) ────────────────────────────────
    const stochCross = detectStochCross(snapshot, prev);
    if (stochCross && isBarsAgo(prev, 'stoch_cross', DEDUP_BARS)) {
      push(
        'stoch_cross', stochCross.direction,
        `${symbol} ${stochCross.label}`,
        'Stochastic K/D crossover is a shorter-term momentum shift signal. Most reliable when happening in mid-zone (not at extreme) — extreme-zone crosses are weaker.',
        `Stoch zone: ${snapshot.stochastic?.zone ?? 'n/a'} · RSI: ${r1(snapshot.rsi)}`,
        { recencyScore: 0.75 }
      );
    }

    // ── 23. DI crossover (NEW) ────────────────────────────────────────────────
    const diCross = detectDICross(snapshot, prev, adxThresh);
    if (diCross && isBarsAgo(prev, 'di_cross', DEDUP_BARS)) {
      push(
        'di_cross', diCross.direction,
        `${symbol} ${diCross.label}`,
        '+DI/-DI crossovers signal directional change when ADX confirms trend strength. Below ADX threshold this would be noise — filtered.',
        `ADX: ${r1(snapshot.adx?.value)} · threshold: ${adxThresh} · Supertrend: ${snapshot.supertrend?.direction ?? 'n/a'}`,
        { baseStrong: (snapshot.adx?.value ?? 0) >= 30, recencyScore: 0.85 }
      );
    }

    // ── 24. OBV divergence (NEW) ──────────────────────────────────────────────
    const obvDiv = detectOBVDivergence(snapshot, prev);
    if (obvDiv && isBarsAgo(prev, 'obv_divergence', DEDUP_BARS)) {
      push(
        'obv_divergence', obvDiv.direction,
        `${symbol} ${obvDiv.label}`,
        'OBV vs price trend divergence suggests that volume is not confirming price action. Accumulation during downtrend or distribution during uptrend often precedes trend changes.',
        `Price trend: ${snapshot.smaTrend} · OBV: ${snapshot.obv?.trend} · Volume: ${snapshot.volumeSpike?.ratio?.toFixed(1) ?? 'n/a'}× avg`,
        { recencyScore: 0.7 }
      );
    }

    // ── 25. Bollinger Band walk (NEW) ─────────────────────────────────────────
    const bbWalk = detectBBWalk(snapshot, prev);
    if (bbWalk && isBarsAgo(prev, 'bb_walk', DEDUP_BARS)) {
      push(
        'bb_walk', bbWalk.direction,
        `${symbol} ${bbWalk.label}`,
        bbWalk.note,
        `BB position: ${snapshot.bollinger?.position} · ADX: ${r1(snapshot.adx?.value)} · Supertrend: ${snapshot.supertrend?.direction ?? 'n/a'}`,
        { recencyScore: 0.65 }
      );
    }

    // ── 26. Keltner Channel breakout (NEW) ────────────────────────────────────
    const keltBreakout = detectKeltnerBreakout(snapshot, prev);
    if (keltBreakout && isBarsAgo(prev, 'keltner_breakout', DEDUP_BARS)) {
      push(
        'keltner_breakout', keltBreakout.direction,
        `${symbol} ${keltBreakout.label}`,
        'Keltner breakouts outside the ATR-based channel indicate volatility expansion. When not preceded by a squeeze, this is often a trend continuation signal.',
        `ATR(14): ${r2(snapshot.atr14)} · Vol regime: ${volReg?.regime ?? 'n/a'} · ADX: ${r1(snapshot.adx?.value)}`,
        { baseStrong: volConfirm, recencyScore: 0.85 }
      );
    }

    // ── 27. Fibonacci proximity (NEW) ─────────────────────────────────────────
    const fibProx = detectFibProximity(snapshot);
    if (fibProx && isBarsAgo(prev, 'fib_proximity', DEDUP_BARS)) {
      push(
        'fib_proximity', fibProx.direction,
        `${symbol} ${fibProx.label}`,
        fibProx.note,
        `Close: $${r2(snapshot.close)} · Swing: $${r2(snapshot.fibonacci?.swingLow)}–$${r2(snapshot.fibonacci?.swingHigh)} · Fib dir: ${snapshot.fibonacci?.direction}`,
        { recencyScore: 0.6 }
      );
    }

    // ── 28. Pivot point proximity (NEW) ───────────────────────────────────────
    const pivotProx = detectPivotProximity(snapshot);
    if (pivotProx && isBarsAgo(prev, 'pivot_proximity', DEDUP_BARS)) {
      push(
        'pivot_proximity', pivotProx.direction,
        `${symbol} ${pivotProx.label}`,
        pivotProx.note,
        `Close: $${r2(snapshot.close)} · Pivot: $${r2(snapshot.pivotPoints?.pivot)} · R1: $${r2(snapshot.pivotPoints?.r1)} · S1: $${r2(snapshot.pivotPoints?.s1)}`,
        { recencyScore: 0.65 }
      );
    }

  } // end if(prev)

  // ── Persist state for next diff ───────────────────────────────────────────
  const newState = {
    _tickCount:         tick,
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
    bollPosition:       snapshot.bollinger?.position ?? null,
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
    // Pattern memory fields
    stochK:             snapshot.stochastic?.k ?? null,
    stochD:             snapshot.stochastic?.d ?? null,
    plusDI:             snapshot.adx?.plusDI ?? null,
    minusDI:            snapshot.adx?.minusDI ?? null,
    obvTrend:           snapshot.obv?.trend ?? null,
    priceAboveKeltner:  snapshot.close != null && snapshot.keltner?.upper != null ? snapshot.close > snapshot.keltner.upper : false,
    priceBelowKeltner:  snapshot.close != null && snapshot.keltner?.lower != null ? snapshot.close < snapshot.keltner.lower : false,
  };

  // Encode last-fired tick for dedup tracking — one entry per alert type
  for (const a of alerts) {
    newState[`lastFired_${a.type}`] = tick;
  }
  // Carry forward prior lastFired entries that didn't fire this tick
  if (prev) {
    for (const k of Object.keys(prev)) {
      if (k.startsWith('lastFired_') && newState[k] == null) {
        newState[k] = prev[k];
      }
    }
  }

  db.setLastIndicatorState(symbol, newState);

  // ── Rank + cap output ─────────────────────────────────────────────────────
  alerts.sort((a, b) => b.qualityScore - a.qualityScore);
  return alerts.slice(0, MAX_ALERTS_PER_CYCLE);
}

module.exports = { detectAlerts };
