// ---- News sources ----
// Two kinds of sources feed this dashboard:
//
// 1. DIRECT_FEEDS — publisher RSS feeds we read straight from the source.
// 2. GOOGLE_NEWS_QUERIES — Google News' public RSS search, which itself
//    aggregates thousands of outlets (this is what gives "every broadcaster"
//    coverage in practice — CNBC, Bloomberg, Reuters, Fox Business, AP, etc.
//    all get indexed there within minutes of publishing).
//
// Both are free and need no API key. Nothing here is a live TV/audio feed —
// that would require paid broadcast-licensing APIs that don't exist for an
// individual user — but between the two lists below, virtually every
// significant published stock/crypto story surfaces here quickly.

const DIRECT_FEEDS = [
  { id: 'cnbc-markets', name: 'CNBC Markets', category: 'stocks', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
  { id: 'cnbc-top', name: 'CNBC Top News', category: 'stocks', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'marketwatch-top', name: 'MarketWatch', category: 'stocks', url: 'https://www.marketwatch.com/rss/topstories' },
  { id: 'marketwatch-pulse', name: 'MarketWatch Pulse', category: 'stocks', url: 'https://www.marketwatch.com/rss/marketpulse' },
  { id: 'yahoo-finance', name: 'Yahoo Finance', category: 'stocks', url: 'https://finance.yahoo.com/news/rssindex' },
  { id: 'investing-com', name: 'Investing.com', category: 'stocks', url: 'https://www.investing.com/rss/news.rss' },
  { id: 'benzinga', name: 'Benzinga', category: 'stocks', url: 'https://www.benzinga.com/feed' },
  { id: 'coindesk', name: 'CoinDesk', category: 'crypto', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'cointelegraph', name: 'Cointelegraph', category: 'crypto', url: 'https://cointelegraph.com/rss' },
  { id: 'decrypt', name: 'Decrypt', category: 'crypto', url: 'https://decrypt.co/feed' },
  { id: 'theblock', name: 'The Block', category: 'crypto', url: 'https://www.theblock.co/rss.xml' },
];

// Google News RSS search — `hl`/`gl`/`ceid` pin it to US/English results.
function googleNewsUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

const GOOGLE_NEWS_QUERIES = [
  { id: 'gn-stocks', name: 'Google News — Stock Market', category: 'stocks', url: googleNewsUrl('stock market OR Wall Street OR S&P 500 OR Nasdaq when:1d') },
  { id: 'gn-crypto', name: 'Google News — Crypto', category: 'crypto', url: googleNewsUrl('crypto OR cryptocurrency OR bitcoin OR ethereum when:1d') },
  { id: 'gn-trump-markets', name: 'Google News — Trump & Markets', category: 'spotlight', url: googleNewsUrl('Trump (stocks OR market OR economy OR tariff OR crypto) when:1d') },
  { id: 'gn-musk-markets', name: 'Google News — Musk & Markets', category: 'spotlight', url: googleNewsUrl('(Musk OR Tesla OR "Elon") (stock OR crypto OR market) when:1d') },
];

const ALL_SOURCES = [...DIRECT_FEEDS, ...GOOGLE_NEWS_QUERIES];

module.exports = { DIRECT_FEEDS, GOOGLE_NEWS_QUERIES, ALL_SOURCES };
