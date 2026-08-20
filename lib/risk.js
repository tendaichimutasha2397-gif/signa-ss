// Risk-management math. Every function here takes numbers the USER supplies
// (their account size, their own entry price, their own stop price) and
// does arithmetic on them. Nothing here decides when to enter, when to
// exit, or how long to hold — that would require predicting the future,
// which this app deliberately does not claim to do (see README). What it
// *can* do honestly: given a position you're already considering, tell you
// how many shares/coins keep your risk on that one trade to the percentage
// of your account you specified.

/**
 * Classic fixed-fractional position sizing: risk a fixed % of account
 * equity on the distance between your entry and your stop.
 *
 * Inputs are all user-supplied: accountSize, riskPct, entryPrice, stopPrice.
 * Optionally targetPrice, purely to report the resulting reward:risk ratio
 * of a plan the user already has — not a suggested target.
 */
function positionSize({ accountSize, riskPct, entryPrice, stopPrice, targetPrice }) {
  const errors = [];
  if (!(accountSize > 0)) errors.push('accountSize must be a positive number.');
  if (!(riskPct > 0 && riskPct <= 100)) errors.push('riskPct must be between 0 and 100.');
  if (!(entryPrice > 0)) errors.push('entryPrice must be a positive number.');
  if (!(stopPrice > 0)) errors.push('stopPrice must be a positive number.');
  if (entryPrice === stopPrice) errors.push('entryPrice and stopPrice cannot be equal.');
  if (errors.length) return { ok: false, errors };

  const direction = stopPrice < entryPrice ? 'long' : 'short';
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  const dollarRisk = accountSize * (riskPct / 100);
  const units = dollarRisk / riskPerUnit;
  const positionValue = units * entryPrice;
  const accountPctInPosition = (positionValue / accountSize) * 100;

  let rewardRisk = null;
  if (targetPrice > 0) {
    const rewardPerUnit = Math.abs(targetPrice - entryPrice);
    rewardRisk = Math.round((rewardPerUnit / riskPerUnit) * 100) / 100;
  }

  return {
    ok: true,
    direction,
    riskPerUnit: round(riskPerUnit),
    dollarRisk: round(dollarRisk),
    units: Math.floor(units * 10000) / 10000,
    wholeUnits: Math.floor(units),
    positionValue: round(positionValue),
    accountPctInPosition: round(accountPctInPosition),
    rewardRiskRatio: rewardRisk,
    note: 'Sizing math only, based on the entry/stop you provided — this does not evaluate whether the trade itself is a good idea, and position value can exceed account size if you\'re using leverage/margin (check accountPctInPosition).',
  };
}

/**
 * A commonly-used ATR-based stop DISTANCE convention (entry ± N×ATR), shown
 * purely as reference math against the asset's own recent volatility — not
 * a recommended stop, not a recommended entry, and not a claim that this
 * multiple is "correct." N defaults to 2, a widely-cited starting point,
 * but it's just an input.
 */
function atrStopDistance({ entryPrice, atr14, multiple = 2, direction = 'long' }) {
  const errors = [];
  if (!(entryPrice > 0)) errors.push('entryPrice must be a positive number.');
  if (!(atr14 > 0)) errors.push('atr14 must be a positive number (fetch it from the asset\'s indicator snapshot).');
  if (!(multiple > 0)) errors.push('multiple must be a positive number.');
  if (!['long', 'short'].includes(direction)) errors.push('direction must be "long" or "short".');
  if (errors.length) return { ok: false, errors };

  const distance = atr14 * multiple;
  const stopPrice = direction === 'long' ? entryPrice - distance : entryPrice + distance;

  return {
    ok: true,
    direction,
    atr14: round(atr14),
    multiple,
    distance: round(distance),
    stopPrice: round(Math.max(stopPrice, 0.0001)),
    note: `A stop this far from entry (${multiple}× the asset's own 14-day ATR) is a common volatility-based convention, not a guarantee the stop is "right" for this trade — tighter stops get hit by noise more often, wider stops risk more per unit. This is reference math, not a recommendation.`,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { positionSize, atrStopDistance };
