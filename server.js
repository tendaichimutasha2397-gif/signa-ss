'use strict';

require('dotenv').config();
const express = require('express');
const path    = require('path');

const db          = require('./lib/db');
const { runIngestCycle } = require('./lib/ingest');
const twitter     = require('./lib/twitter');
const youtube     = require('./lib/youtube');
const prices      = require('./lib/prices');
const signals     = require('./lib/signals');
const rules       = require('./lib/rules');
const risk        = require('./lib/risk');
const correlation = require('./lib/correlation');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT            = process.env.PORT || 3000;
const NEWS_POLL_MS    = Number(process.env.NEWS_POLL_MS    || 3 * 60 * 1000);
const TWITTER_POLL_MS = Number(process.env.TWITTER_POLL_MS || 60 * 1000);
const PRICE_POLL_MS   = Number(process.env.PRICE_POLL_MS   || 2 * 60 * 1000);

// ---- SSE broadcast ----
const sseClients = new Set();

function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { /* client disconnected race */ }
  }
}

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
  // Keep-alive ping every 25 s to prevent proxy timeouts
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); sseClients.delete(res); }
  }, 25000);
  req.on('close', () => clearInterval(ping));
});

// ---- REST ----
app.get('/api/config', (req, res) => {
  res.json({
    twitterEnabled: twitter.enabled,
    youtubeEnabled: youtube.enabled,
    watchlist:      db.getWatchlist(),
    extraKeywords:  db.getExtraKeywords(),
    stats:          db.stats(),
    newsPollMs:     NEWS_POLL_MS,
    twitterPollMs:  TWITTER_POLL_MS,
  });
});

app.get('/api/feed', (req, res) => {
  const { category = 'all', limit = '100', spotlightOnly } = req.query;
  res.json({
    items: db.getItems({
      category,
      limit: Math.min(Number(limit) || 100, 400),
      spotlightOnly: spotlightOnly === 'true',
    }),
  });
});

app.get('/api/watchlist', (req, res) => res.json({ watchlist: db.getWatchlist() }));

app.post('/api/watchlist', (req, res) => {
  const { watchlist } = req.body || {};
  if (!Array.isArray(watchlist)) return res.status(400).json({ ok: false, reason: 'watchlist must be an array' });
  const cleaned = watchlist
    .filter(p => p && typeof p.name === 'string' && p.name.trim())
    .slice(0, 50) // reasonable cap
    .map(p => ({
      name: p.name.trim().slice(0, 100),
      aliases: Array.isArray(p.aliases) && p.aliases.length
        ? p.aliases.map(a => String(a).trim().slice(0, 100)).filter(Boolean).slice(0, 20)
        : [p.name.trim().toLowerCase()],
    }));
  db.setWatchlist(cleaned);
  res.json({ ok: true, watchlist: cleaned });
});

// Refresh lock — prevents concurrent API hammering if the button is clicked rapidly
let refreshInFlight = false;
app.post('/api/refresh', async (req, res) => {
  if (refreshInFlight) return res.json({ ok: true, added: 0, note: 'refresh already in progress' });
  refreshInFlight = true;
  try {
    const [newsAdded, twitterAdded] = await Promise.all([
      runIngestCycle(),
      twitter.runTwitterIngestCycle(),
    ]);
    const added = [...newsAdded, ...twitterAdded];
    if (added.length) broadcast('items', added);
    res.json({ ok: true, added: added.length });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  } finally {
    refreshInFlight = false;
  }
});

// ---- Prices & indicators ----
app.get('/api/assets', (req, res) => {
  res.json({ trackedAssets: db.getTrackedAssets(), available: Object.keys(prices.ASSET_MAP) });
});

app.post('/api/assets', (req, res) => {
  const { symbols } = req.body || {};
  if (!Array.isArray(symbols)) return res.status(400).json({ ok: false, reason: 'symbols must be an array' });
  const cleaned = [...new Set(symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, 20);
  const unknown = cleaned.filter(s => !prices.ASSET_MAP[s]);
  if (unknown.length) return res.status(400).json({
    ok: false,
    reason: `Unsupported symbol(s): ${unknown.join(', ')}. Supported: ${Object.keys(prices.ASSET_MAP).join(', ')}`,
  });
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

app.get('/api/multi-timeframe', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ ok: false, reason: 'Missing symbol.' });
  const result = await prices.getMultiTimeframe(String(symbol).toUpperCase());
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
});

app.post('/api/backtest', async (req, res) => {
  const { symbol, conditions, groups, horizonDays, walkForward, folds } = req.body || {};
  if (!symbol) return res.status(400).json({ ok: false, reason: 'Missing symbol.' });
  const hist = await prices.getHistory(String(symbol).toUpperCase());
  if (!hist.ok) return res.status(502).json(hist);
  const result = rules.backtestRule({
    closes: hist.closes, highs: hist.highs, lows: hist.lows, volumes: hist.volumes,
    conditions, groups,
    horizonDays: Number(horizonDays) || 5,
    walkForward: walkForward !== false,
    folds: Number(folds) || 4,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.get('/api/rules-metadata', (req, res) => {
  res.json({ metrics: rules.METRICS, operators: rules.OPERATORS });
});

app.get('/api/correlation', async (req, res) => {
  try {
    const symbols = db.getTrackedAssets();
    if (symbols.length < 2) return res.status(400).json({ ok: false, reason: 'Track at least 2 assets to compute correlation.' });
    const closesBySymbol = await prices.getMultiHistory(symbols);
    if (Object.keys(closesBySymbol).length < 2) return res.status(502).json({ ok: false, reason: 'Not enough price history available right now.' });
    res.json({ ok: true, ...correlation.buildCorrelationMatrix(closesBySymbol) });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  }
});

// ---- Risk ----
app.post('/api/risk/position-size', (req, res) => {
  const { accountSize, riskPct, entryPrice, stopPrice, targetPrice } = req.body || {};
  const result = risk.positionSize({
    accountSize: Number(accountSize), riskPct: Number(riskPct),
    entryPrice: Number(entryPrice), stopPrice: Number(stopPrice),
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
      return res.status(400).json({ ok: false, errors: [`ATR unavailable for ${symbol} right now.`] });
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

// ---- TradingView symbols ----
app.get('/api/tv-symbols', (req, res) => res.json({ symbols: db.getTvSymbols() }));

app.post('/api/tv-symbols', (req, res) => {
  const { symbols } = req.body || {};
  if (!Array.isArray(symbols)) return res.status(400).json({ ok: false, reason: 'symbols must be an array' });
  const cleaned = [...new Set(
    symbols.map(s => String(s).trim().toUpperCase().slice(0, 50)).filter(Boolean)
  )].slice(0, 30);
  db.setTvSymbols(cleaned);
  res.json({ ok: true, symbols: cleaned });
});

// ---- YouTube ----
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

// ---- Background polling ----
async function newsTick() {
  try {
    const added = await runIngestCycle();
    if (added.length) broadcast('items', added);
  } catch (e) { console.warn('[newsTick]', e.message); }
}

async function twitterTick() {
  if (!twitter.enabled) return;
  try {
    const added = await twitter.runTwitterIngestCycle();
    if (added.length) broadcast('items', added);
  } catch (e) { console.warn('[twitterTick]', e.message); }
}

// Per-symbol error isolation: one failed fetch cannot kill the whole price tick.
async function pricesTick() {
  const symbols = db.getTrackedAssets();
  if (!symbols.length) return;

  let snapshot = {};
  try {
    snapshot = await prices.getSnapshot(symbols);
  } catch (e) {
    console.warn('[pricesTick] getSnapshot failed:', e.message);
    return;
  }

  const newAlerts = [];
  for (const sym of symbols) {
    try {
      const entry = snapshot[sym];
      if (entry && entry.ok) {
        const alerts = signals.detectAlerts(sym, entry);
        alerts.forEach(a => { db.addAlert(a); newAlerts.push(a); });
      }
    } catch (e) {
      console.warn(`[pricesTick] alert detection failed for ${sym}:`, e.message);
    }
  }

  broadcast('prices', { snapshot, updatedAt: new Date().toISOString() });
  if (newAlerts.length) broadcast('alerts', newAlerts);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Market Pulse running on port ${PORT}`);
  console.log(twitter.enabled ? 'X/Twitter: enabled' : 'X/Twitter: disabled (set X_BEARER_TOKEN)');
  console.log(youtube.enabled ? 'YouTube: enabled'   : 'YouTube: disabled (set YOUTUBE_API_KEY)');
  setTimeout(newsTick,    2000);
  setTimeout(twitterTick, 4000);
  setTimeout(pricesTick,  6000);
  setInterval(newsTick,    NEWS_POLL_MS);
  setInterval(twitterTick, TWITTER_POLL_MS);
  setInterval(pricesTick,  PRICE_POLL_MS);
});
