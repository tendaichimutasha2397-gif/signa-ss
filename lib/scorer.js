// Default watchlist of public figures whose statements get spotlighted.
// Editable at runtime via the dashboard (persisted in data.json by db.js).
const DEFAULT_WATCHLIST = [
  { name: 'Donald Trump', aliases: ['trump', 'donald trump', 'president trump'] },
  { name: 'Elon Musk', aliases: ['elon musk', 'elon', 'musk'] },
];

// Tickers/assets we recognize by name so headlines mentioning them get tagged
// even when the $TICKER form isn't used.
const KNOWN_ASSETS = [
  { symbol: 'BTC', names: ['bitcoin', 'btc'] },
  { symbol: 'ETH', names: ['ethereum', 'eth', 'ether'] },
  { symbol: 'DOGE', names: ['dogecoin', 'doge'] },
  { symbol: 'SOL', names: ['solana'] },
  { symbol: 'TSLA', names: ['tesla'] },
  { symbol: 'AAPL', names: ['apple'] },
  { symbol: 'NVDA', names: ['nvidia'] },
  { symbol: 'MSFT', names: ['microsoft'] },
  { symbol: 'AMZN', names: ['amazon'] },
  { symbol: 'META', names: ['meta', 'facebook'] },
  { symbol: 'GOOGL', names: ['google', 'alphabet'] },
];

// Words that tend to show up in headlines about something that actually
// moves a market, as opposed to routine coverage. Not a guarantee of
// impact — a fast heuristic to help you triage what to look at first.
const MOVER_KEYWORDS = [
  'surge', 'surges', 'soar', 'soars', 'plunge', 'plunges', 'crash', 'crashes',
  'rally', 'rallies', 'tumble', 'tumbles', 'spike', 'spikes', 'slump',
  'all-time high', 'record high', 'record low',
  'ban', 'bans', 'banned', 'tariff', 'tariffs', 'sanction', 'sanctions',
  'sec ', 'lawsuit', 'investigation', 'subpoena', 'indictment',
  'announces', 'announced', 'launch', 'launches', 'unveils',
  'buys', 'buying', 'acquires', 'acquisition', 'sells', 'selling', 'dumps',
  'invest', 'investment', 'stake', 'ipo', 'merger',
  'interest rate', 'rate cut', 'rate hike', 'fed ', 'federal reserve',
  'bankruptcy', 'default', 'delist', 'delisted', 'hack', 'hacked', 'exploit',
  'etf', 'approval', 'approved', 'rejected',
];

const TICKER_REGEX = /\$[A-Z]{1,6}\b/g;

function textOf(item) {
  return `${item.title || ''} ${item.summary || ''}`;
}

function tagFigures(item, watchlist) {
  const text = textOf(item).toLowerCase();
  const hits = [];
  for (const person of watchlist) {
    if (person.aliases.some((a) => text.includes(a.toLowerCase()))) {
      hits.push(person.name);
    }
  }
  return hits;
}

function tagAssets(item) {
  const text = textOf(item);
  const lower = text.toLowerCase();
  const hits = new Set();
  for (const asset of KNOWN_ASSETS) {
    if (asset.names.some((n) => lower.includes(n))) hits.add(asset.symbol);
  }
  const tickerMatches = text.match(TICKER_REGEX) || [];
  tickerMatches.forEach((t) => hits.add(t.replace('$', '')));
  return [...hits];
}

function moverScore(item) {
  const lower = textOf(item).toLowerCase();
  let score = 0;
  for (const kw of MOVER_KEYWORDS) {
    if (lower.includes(kw)) score += 1;
  }
  return score;
}

/**
 * Enriches a raw feed item with figure tags, asset tags, a mover score, and
 * a spotlight flag. `watchlist` is the user's current tracked-figures list.
 */
function scoreItem(item, watchlist) {
  const figures = tagFigures(item, watchlist);
  const assets = tagAssets(item);
  const mover = moverScore(item);
  const spotlight = figures.length > 0;
  // Simple composite priority: spotlighted figures matter most, then how
  // many "mover" keywords fired, then whether it names a recognized asset.
  const priority = (spotlight ? 50 : 0) + mover * 8 + (assets.length ? 5 : 0);
  return { ...item, figures, assets, moverScore: mover, spotlight, priority };
}

module.exports = { DEFAULT_WATCHLIST, KNOWN_ASSETS, scoreItem };
