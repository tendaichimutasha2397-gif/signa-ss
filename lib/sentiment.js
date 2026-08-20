// Lightweight lexicon-based tone tagging for headlines/summaries. This is a
// word-count heuristic, not real NLP sentiment analysis and not a signal —
// it's here so you can eyeball "does this batch of headlines skew positive
// or negative" at a glance. Every result carries its raw counts so it's
// auditable rather than a black-box label.

const POSITIVE_WORDS = [
  'surge', 'surges', 'surged', 'soar', 'soars', 'soared', 'rally', 'rallies', 'rallied',
  'jump', 'jumps', 'jumped', 'gain', 'gains', 'gained', 'climb', 'climbs', 'climbed',
  'rise', 'rises', 'rose', 'rebound', 'rebounds', 'beat', 'beats', 'beating',
  'record high', 'all-time high', 'upgrade', 'upgrades', 'upgraded', 'outperform',
  'bullish', 'optimism', 'optimistic', 'strong', 'strength', 'growth', 'profit',
  'profits', 'profitable', 'expand', 'expands', 'expansion', 'breakthrough',
  'approval', 'approved', 'partnership', 'buyback', 'boom', 'recovery', 'recovers',
];

const NEGATIVE_WORDS = [
  'plunge', 'plunges', 'plunged', 'crash', 'crashes', 'crashed', 'tumble', 'tumbles',
  'tumbled', 'slump', 'slumps', 'slumped', 'drop', 'drops', 'dropped', 'fall', 'falls',
  'fell', 'sink', 'sinks', 'sank', 'decline', 'declines', 'declined', 'miss', 'misses',
  'missed', 'record low', 'downgrade', 'downgrades', 'downgraded', 'underperform',
  'bearish', 'pessimism', 'pessimistic', 'weak', 'weakness', 'recession', 'loss',
  'losses', 'layoffs', 'lawsuit', 'investigation', 'subpoena', 'indictment', 'default',
  'bankruptcy', 'fraud', 'hack', 'hacked', 'exploit', 'sell-off', 'selloff', 'sanction',
  'sanctions', 'ban', 'banned', 'delist', 'delisted', 'warning', 'cuts jobs', 'plummet',
  'plummets', 'plummeted',
];

function textOf(item) {
  return `${item.title || ''} ${item.summary || ''}`.toLowerCase();
}

function countHits(text, words) {
  let count = 0;
  const hits = [];
  for (const w of words) {
    if (text.includes(w)) { count += 1; hits.push(w); }
  }
  return { count, hits };
}

/**
 * Returns { tone, score, positiveHits, negativeHits }. `tone` is one of
 * 'positive' | 'negative' | 'neutral' — purely a word-count comparison, not
 * a claim about market impact or direction. `score` is posCount - negCount.
 */
function scoreSentiment(item) {
  const text = textOf(item);
  const pos = countHits(text, POSITIVE_WORDS);
  const neg = countHits(text, NEGATIVE_WORDS);
  const score = pos.count - neg.count;
  const tone = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  return {
    tone,
    score,
    positiveHits: pos.hits,
    negativeHits: neg.hits,
  };
}

module.exports = { scoreSentiment };
