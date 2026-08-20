require('dotenv').config();
const express = require('express');
const path = require('path');

const db = require('./lib/db');
const { runIngestCycle } = require('./lib/ingest');
const twitter = require('./lib/twitter');
const youtube = require('./lib/youtube');
const prices = require('./lib/prices');
const signals = require('./lib/signals');
const rules = require('./lib/rules');
const risk = require('./lib/risk');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const NEWS_POLL_MS = Number(process.env.NEWS_POLL_MS || 3 * 60 * 1000); // 3 min — polite to free RSS sources
const TWITTER_POLL_MS = Number(process.env.TWITTER_POLL_MS || 60 * 1000); // 1 min — X posts move faster
const PRICE_POLL_MS = Number(process.env.PRICE_POLL_MS || 2 * 60 * 1000); // 2 min — polite to free price APIs

// ---- SSE: push newly-ingested items to connected dashboards ----
const sseClients = new Set();

function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(line);
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---- REST API ----
app.get('/api/config', (req, res) => {
  res.json({
    twitterEnabled: twitter.enabled,
    youtubeEnabled: youtube.enabled,
    watchlist: db.getWatchlist(),
    extraKeywords: db.getExtraKeywords(),
    stats: db.stats(),
    newsPollMs: NEWS_POLL_MS,
    twitterPollMs: TWITTER_POLL_MS,
  });
});

app.get('/api/feed', (req, res) => {
  const { category = 'all', limit = '100', spotlightOnly } = req.query;
  const items = db.getItems({
    category,
    limit: Math.min(Number(limit) || 100, 400),
    spotlightOnly: spotlightOnly === 'true',
  });
  res.json({ items });
});

app.get('/api/watchlist', (req, res) => {
  res.json({ watchlist: db.getWatchlist() });
});

app.post('/api/watchlist', (req, res) => {
  const { watchlist } = req.body || {};
  if (!Array.isArray(watchlist)) return res.status(400).json({ ok: false, reason: 'watchlist must be an array' });
  const cleaned = watchlist
    .filter((p) => p && typeof p.name === 'string' && p.name.trim())
    .map((p) => ({
      name: p.name.trim(),
      aliases: Array.isArray(p.aliases) && p.aliases.length
        ? p.aliases.map((a) => String(a).trim()).filter(Boolean)
        : [p.name.trim().toLowerCase()],
    }));
  db.setWatchlist(cleaned);
  res.json({ ok: true, watchlist: cleaned });
});

app.post('/api/refresh', async (req, res) => {
  try {
    const [newsAdded, twitterAdded] = await Promise.all([runIngestCycle(), twitter.runTwitterIngestCycle()]);
    const added = [...newsAdded, ...twitterAdded];
    if (added.length) broadcast('items', added);
    res.json({ ok: true, added: added.length });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  }
});

// ---- Prices & indicators ----
// Reference data only — current price, 24h change, and a few standard
// technical indicators (RSI, SMA20/50 trend, MACD histogram, volume spike).
// None of this is a buy/sell recommendation; see README for why an
// "accurate" auto-trading signal isn't something this (or any) tool can
// honestly claim to provide.
app.get('/api/assets', (req, res) => {
  res.json({ trackedAssets: db.getTrackedAssets(), available: Object.keys(prices.ASSET_MAP) });
});

app.post('/api/assets', (req, res) => {
  const { symbols } = req.body || {};
  if (!Array.isArray(symbols)) return res.status(400).json({ ok: false, reason: 'symbols must be an array' });
  const cleaned = [...new Set(symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const unknown = cleaned.filter((s) => !prices.ASSET_MAP[s]);
  if (unknown.length) return res.status(400).json({ ok: false, reason: `Unsupported symbol(s): ${unknown.join(', ')}. Supported: ${Object.keys(prices.ASSET_MAP).join(', ')}` });
  db.setTrackedAssets(cleaned);
  res.json({ ok: true, trackedAssets: cleaned });
});

app.get('/api/prices', async (req, res) => {
  try {
    const snapshot = await prices.getSnapshot(db.getTrackedAssets());
    res.json({ ok: true, snapshot, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  }
});

app.get('/api/asset-history', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ ok: false, reason: 'Missing symbol.' });
  const hist = await prices.getHistory(String(symbol).toUpperCase());
  if (!hist.ok) return res.status(502).json(hist);
  res.json(hist);
});

app.get('/api/alerts', (req, res) => {
  res.json({ alerts: db.getAlerts(Number(req.query.limit) || 50) });
});

// Multi-timeframe confluence view — same reading counts as /api/prices,
// computed separately at 1h/4h/1d (crypto) so you can see whether shorter
// and longer horizons agree. Stocks are daily-only; see lib/prices.js for why.
app.get('/api/multi-timeframe', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ ok: false, reason: 'Missing symbol.' });
  const result = await prices.getMultiTimeframe(String(symbol).toUpperCase());
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
});

// User-defined, backtestable rules. The person supplies the condition(s);
// this endpoint reports how often that exact condition preceded an up/down
// move historically. It never suggests a rule and never returns a verdict —
// see lib/rules.js for the reasoning.
app.post('/api/backtest', async (req, res) => {
  const { symbol, conditions, horizonDays } = req.body || {};
  if (!symbol) return res.status(400).json({ ok: false, reason: 'Missing symbol.' });
  const hist = await prices.getHistory(String(symbol).toUpperCase());
  if (!hist.ok) return res.status(502).json(hist);
  const result = rules.backtestRule({
    closes: hist.closes,
    conditions,
    horizonDays: Number(horizonDays) || 5,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.get('/api/rules-metadata', (req, res) => {
  res.json({ metrics: rules.METRICS, operators: rules.OPERATORS });
});

// ---- Risk tools ----
// Pure calculators driven by numbers the caller supplies (their own
// account size, their own entry/stop/target). These never choose an entry,
// exit, or hold duration for you — see lib/risk.js for why.
app.post('/api/risk/position-size', (req, res) => {
  const { accountSize, riskPct, entryPrice, stopPrice, targetPrice } = req.body || {};
  const result = risk.positionSize({
    accountSize: Number(accountSize),
    riskPct: Number(riskPct),
    entryPrice: Number(entryPrice),
    stopPrice: Number(stopPrice),
    targetPrice: targetPrice != null && targetPrice !== '' ? Number(targetPrice) : undefined,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/risk/atr-stop', async (req, res) => {
  const { symbol, entryPrice, multiple, direction } = req.body || {};
  if (!symbol) return res.status(400).json({ ok: false, errors: ['Missing symbol.'] });
  try {
    const snapshot = await prices.getSnapshot([String(symbol).toUpperCase()]);
    const entry = snapshot[String(symbol).toUpperCase()];
    if (!entry || !entry.ok || entry.atr14 == null) {
      return res.status(400).json({ ok: false, errors: [`ATR unavailable for ${symbol} right now (needs OHLC history).`] });
    }
    const result = risk.atrStopDistance({
      entryPrice: Number(entryPrice) || entry.price,
      atr14: entry.atr14,
      multiple: multiple != null && multiple !== '' ? Number(multiple) : undefined,
      direction: direction || 'long',
    });
    if (!result.ok) return res.status(400).json(result);
    res.json({ ...result, symbol: String(symbol).toUpperCase(), currentPrice: entry.price });
  } catch (e) {
    res.status(500).json({ ok: false, errors: [e.message] });
  }
});

// ---- TradingView any-symbol tracker ----
// Free-form symbol list (stocks on any exchange, crypto, forex, indices,
// futures — whatever TradingView's own widgets resolve). No price/indicator
// computation happens on this server for these — the frontend embeds
// TradingView's own chart + Technical Analysis widgets directly, so this
// endpoint just persists which symbols to show, shared across visitors like
// the figure watchlist.
app.get('/api/tv-symbols', (req, res) => {
  res.json({ symbols: db.getTvSymbols() });
});

app.post('/api/tv-symbols', (req, res) => {
  const { symbols } = req.body || {};
  if (!Array.isArray(symbols)) return res.status(400).json({ ok: false, reason: 'symbols must be an array' });
  const cleaned = [...new Set(symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, 30);
  db.setTvSymbols(cleaned);
  res.json({ ok: true, symbols: cleaned });
});

// Video search — best-effort candidates only, never presented as a
// confirmed match to a specific statement. See lib/youtube.js.
app.get('/api/video-search', async (req, res) => {
  if (!youtube.enabled) return res.status(400).json({ ok: false, reason: 'YOUTUBE_API_KEY is not set on the server.' });
  const { q, publishedAfter } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ ok: false, reason: 'Missing search query.' });
  const result = await youtube.searchVideos(q, { publishedAfter });
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- background polling ----
async function newsTick() {
  try {
    const added = await runIngestCycle();
    if (added.length) broadcast('items', added);
  } catch (e) {
    console.warn('[newsTick]', e.message);
  }
}

async function twitterTick() {
  if (!twitter.enabled) return;
  try {
    const added = await twitter.runTwitterIngestCycle();
    if (added.length) broadcast('items', added);
  } catch (e) {
    console.warn('[twitterTick]', e.message);
  }
}

async function pricesTick() {
  try {
    const symbols = db.getTrackedAssets();
    const snapshot = await prices.getSnapshot(symbols);
    const newAlerts = [];
    for (const sym of symbols) {
      const entry = snapshot[sym];
      if (entry && entry.ok) {
        const alerts = signals.detectAlerts(sym, entry);
        alerts.forEach((a) => { db.addAlert(a); newAlerts.push(a); });
      }
    }
    broadcast('prices', { snapshot, updatedAt: new Date().toISOString() });
    if (newAlerts.length) broadcast('alerts', newAlerts);
  } catch (e) {
    console.warn('[pricesTick]', e.message);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Market Pulse running on port ${PORT}`);
  console.log(twitter.enabled ? 'X/Twitter live search: enabled' : 'X/Twitter live search: disabled (set X_BEARER_TOKEN to enable)');
  console.log(youtube.enabled ? 'YouTube video search: enabled' : 'YouTube video search: disabled (set YOUTUBE_API_KEY to enable)');
  // Fire an initial cycle shortly after boot, then settle into the poll interval.
  setTimeout(newsTick, 2000);
  setTimeout(twitterTick, 4000);
  setTimeout(pricesTick, 6000);
  setInterval(newsTick, NEWS_POLL_MS);
  setInterval(twitterTick, TWITTER_POLL_MS);
  setInterval(pricesTick, PRICE_POLL_MS);
});
