// Cross-asset correlation matrix over daily returns. This is real,
// well-defined statistics (Pearson correlation coefficient) about how
// closely two assets' price *changes* have moved together historically —
// useful for understanding diversification (or the lack of it) across a
// tracked list. It is NOT a prediction that the relationship continues,
// and correlations between assets are well known to shift over time,
// especially during stress periods when many things suddenly move
// together regardless of their normal relationship.

// Daily % returns from a closing-price series (oldest-first).
function returnsFromCloses(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null; // too few overlapping points to mean much
  const av = a.slice(-n);
  const bv = b.slice(-n);
  const meanA = av.reduce((x, y) => x + y, 0) / n;
  const meanB = bv.reduce((x, y) => x + y, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = av[i] - meanA;
    const db = bv[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (!varA || !varB) return null;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Builds a full pairwise correlation matrix from a map of
 * symbol -> closing-price array (all same order, oldest-first; lengths can
 * differ, the last N overlapping points are used per pair).
 * Returns { symbols, matrix } where matrix[i][j] is the correlation
 * between symbols[i] and symbols[j] (1 on the diagonal), plus a flat list
 * of the most correlated and least/negatively correlated pairs for a
 * quick read.
 */
function buildCorrelationMatrix(closesBySymbol) {
  const symbols = Object.keys(closesBySymbol).filter((s) => closesBySymbol[s] && closesBySymbol[s].length > 10);
  const returns = {};
  symbols.forEach((s) => { returns[s] = returnsFromCloses(closesBySymbol[s]); });

  const matrix = symbols.map((a) => symbols.map((b) => {
    if (a === b) return 1;
    const r = pearson(returns[a], returns[b]);
    return r == null ? null : Math.round(r * 100) / 100;
  }));

  const pairs = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const v = matrix[i][j];
      if (v != null) pairs.push({ a: symbols[i], b: symbols[j], correlation: v });
    }
  }
  pairs.sort((x, y) => y.correlation - x.correlation);
  const mostCorrelated = pairs.slice(0, 3);
  const leastCorrelated = pairs.slice(-3).reverse();

  return {
    symbols,
    matrix,
    mostCorrelated,
    leastCorrelated,
    note: 'Correlation of daily % returns over the available history window. Relationships between assets shift over time, especially in risk-off periods when correlations tend to rise across the board — this is a snapshot, not a forecast.',
  };
}

module.exports = { buildCorrelationMatrix, pearson, returnsFromCloses };
