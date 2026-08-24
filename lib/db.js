'use strict';

const fs   = require('fs');
const path = require('path');
const { DEFAULT_WATCHLIST } = require('./scorer');

const DB_FILE       = path.join(__dirname, '..', 'data.json');
const MAX_ITEMS     = 400;
const MAX_ALERTS    = 100;
const DEFAULT_ASSETS     = ['BTC', 'ETH', 'SOL', 'TSLA', 'AAPL', 'NVDA'];
const DEFAULT_TV_SYMBOLS = ['NASDAQ:AAPL', 'NASDAQ:TSLA', 'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'];

let state = load();

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      items:              parsed.items              || [],
      seenIds:            parsed.seenIds            || {},
      watchlist:          parsed.watchlist && parsed.watchlist.length ? parsed.watchlist : DEFAULT_WATCHLIST,
      extraKeywords:      parsed.extraKeywords      || [],
      trackedAssets:      parsed.trackedAssets && parsed.trackedAssets.length ? parsed.trackedAssets : DEFAULT_ASSETS,
      tvSymbols:          parsed.tvSymbols && parsed.tvSymbols.length ? parsed.tvSymbols : DEFAULT_TV_SYMBOLS,
      alerts:             parsed.alerts             || [],
      lastIndicatorState: parsed.lastIndicatorState || {},
    };
  } catch {
    return {
      items: [], seenIds: {}, watchlist: DEFAULT_WATCHLIST, extraKeywords: [],
      trackedAssets: DEFAULT_ASSETS, tvSymbols: DEFAULT_TV_SYMBOLS,
      alerts: [], lastIndicatorState: {},
    };
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(state, null, 2), err => {
      if (err) console.warn('[db] write error:', err.message);
    });
  }, 500);
}

function hasSeen(id) { return Boolean(state.seenIds[id]); }

function addItems(newItems) {
  const added = [];
  for (const item of newItems) {
    if (state.seenIds[item.id]) continue;
    state.seenIds[item.id] = true;
    state.items.unshift(item);
    added.push(item);
  }
  if (added.length) {
    state.items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    state.items = state.items.slice(0, MAX_ITEMS);
    // Rolling seenIds cap — keeps last 2000 plus anything still in items
    const keep = new Set(state.items.map(i => i.id));
    const seenKeys = Object.keys(state.seenIds);
    if (seenKeys.length > 2000) {
      const trimmed = {};
      seenKeys.slice(-2000).forEach(k => { trimmed[k] = true; });
      keep.forEach(k => { trimmed[k] = true; });
      state.seenIds = trimmed;
    }
    save();
  }
  return added;
}

function getItems({ limit = 100, category = 'all', spotlightOnly = false } = {}) {
  let items = state.items;
  if (category !== 'all') items = items.filter(i => i.category === category || (category === 'spotlight' && i.spotlight));
  if (spotlightOnly) items = items.filter(i => i.spotlight);
  return items.slice(0, limit);
}

function getWatchlist()        { return state.watchlist; }
function setWatchlist(list)    { state.watchlist = list; save(); }

function getExtraKeywords()    { return state.extraKeywords; }
function setExtraKeywords(list){ state.extraKeywords = list; save(); }

function getTrackedAssets()    { return state.trackedAssets; }
function setTrackedAssets(list){ state.trackedAssets = list; save(); }

function getTvSymbols()        { return state.tvSymbols; }
function setTvSymbols(list)    { state.tvSymbols = list; save(); }

function addAlert(alert) {
  state.alerts.unshift(alert);
  state.alerts = state.alerts.slice(0, MAX_ALERTS);
  save();
  return alert;
}

function getAlerts(limit = 50) { return state.alerts.slice(0, limit); }

function getLastIndicatorState(symbol)          { return state.lastIndicatorState[symbol] || null; }
function setLastIndicatorState(symbol, snapshot) { state.lastIndicatorState[symbol] = snapshot; save(); }

function stats() {
  return {
    totalItems:    state.items.length,
    spotlightItems: state.items.filter(i => i.spotlight).length,
    lastItemAt:    state.items[0] ? state.items[0].publishedAt : null,
  };
}

module.exports = {
  hasSeen, addItems, getItems, getWatchlist, setWatchlist,
  getExtraKeywords, setExtraKeywords, stats,
  getTrackedAssets, setTrackedAssets, getTvSymbols, setTvSymbols,
  addAlert, getAlerts, getLastIndicatorState, setLastIndicatorState,
};
