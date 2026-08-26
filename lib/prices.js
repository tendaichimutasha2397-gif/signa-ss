'use strict';

const WebSocket = require('ws');
const { computeIndicators } = require('./indicators');

// Symbol -> data-source mapping. Crypto goes through CoinGecko (free, no
// key). Stocks go through Stooq's public CSV endpoints (free, no key,
// ~15-20min delayed). Deriv synthetic indices go through Deriv's public
// WebSocket API (free, no account needed for ticks_history reads).
const ASSET_MAP = {
  // -- crypto (CoinGecko) --
  BTC:  { type: 'crypto', id: 'bitcoin' },
  ETH:  { type: 'crypto', id: 'ethereum' },
  SOL:  { type: 'crypto', id: 'solana' },
  DOGE: { type: 'crypto', id: 'dogecoin' },
  XRP:  { type: 'crypto', id: 'ripple' },
  ADA:  { type: 'crypto', id: 'cardano' },
  AVAX: { type: 'crypto', id: 'avalanche-2' },
  LINK: { type: 'crypto', id: 'chainlink' },
  MATIC:{ type: 'crypto', id: 'matic-network' },
  LTC:  { type: 'crypto', id: 'litecoin' },
  DOT:  { type: 'crypto', id: 'polkadot' },
  BNB:  { type: 'crypto', id: 'binancecoin' },
  // -- stocks (Stooq -> Yahoo fallback) --
  TSLA: { type: 'stock', id: 'tsla.us' },
  AAPL: { type: 'stock', id: 'aapl.us' },
  NVDA: { type: 'stock', id: 'nvda.us' },
  MSFT: { type: 'stock', id: 'msft.us' },
  AMZN: { type: 'stock', id: 'amzn.us' },
  META: { type: 'stock', id: 'meta.us' },
  GOOGL:{ type: 'stock', id: 'googl.us' },
  NFLX: { type: 'stock', id: 'nflx.us' },
  AMD:  { type: 'stock', id: 'amd.us' },
  INTC: { type: 'stock', id: 'intc.us' },
  JPM:  { type: 'stock', id: 'jpm.us' },
  BAC:  { type: 'stock', id: 'bac.us' },
  DIS:  { type: 'stock', id: 'dis.us' },
  COIN: { type: 'stock', id: 'coin.us' },
  PLTR: { type: 'stock', id: 'pltr.us' },
  // -- Deriv synthetic indices (free public API, 24/7, no account required) --
  VOLATILITY_10_INDEX:   { type: 'deriv', id: 'R_10',     display: 'Volatility 10 Index'   },
  VOLATILITY_25_INDEX:   { type: 'deriv', id: 'R_25',     display: 'Volatility 25 Index'   },
  VOLATILITY_50_INDEX:   { type: 'deriv', id: 'R_50',     display: 'Volatility 50 Index'   },
  VOLATILITY_75_INDEX:   { type: 'deriv', id: 'R_75',     display: 'Volatility 75 Index'   },
  VOLATILITY_100_INDEX:  { type: 'deriv', id: 'R_100',    display: 'Volatility 100 Index'  },
  BOOM_300_INDEX:        { type: 'deriv', id: 'BOOM300N', display: 'Boom 300 Index'        },
  BOOM_500_INDEX:        { type: 'deriv', id: 'BOOM500',  display: 'Boom 500 Index'        },
  BOOM_1000_INDEX:       { type: 'deriv', id: 'BOOM1000', display: 'Boom 1000 Index'       },
  CRASH_300_INDEX:       { type: 'deriv', id: 'CRASH300N',display: 'Crash 300 Index'       },
  CRASH_500_INDEX:       { type: 'deriv', id: 'CRASH500', display: 'Crash 500 Index'       },
  CRASH_1000_INDEX:      { type: 'deriv', id: 'CRASH1000',display: 'Crash 1000 Index'      },
  STEP_INDEX:            { type: 'deriv', id: 'STPIDX',   display: 'Step Index'            },
  RANGE_BREAK_100_INDEX: { type: 'deriv', id: 'RB100',    display: 'Range Break 100 Index' },
  RANGE_BREAK_200_INDEX: { type: 'deriv', id: 'RB200',    display: 'Range Break 200 Index' },
};

function stockSymbolFor(sym) {
  return sym.toLowerCase().includes('.') ? sym.toLowerCase() : `${sym.toLowerCase()}.us`;
}

// ---- in-memory cache shared across all fetch helpers ----
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), ttlMs, data });
  return data;
}

// ════════════════════════════════════════════════════════════════
//  DERIV API — WebSocket, one-shot request/response per call.
//  Deriv has no REST endpoint; their API is WebSocket-only.
//  fetchDerivWS opens a connection, sends one JSON request, waits
//  for the matching response (req_id: 1), then closes the socket.
//  All callers are TTL-cached so concurrent hits share the result
//  without multiplying WS connections for the same symbol.
// ════════════════════════════════════════════════════════════════

const DERIV_WS_URL  = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
const DERIV_TIMEOUT = 12000;

function fetchDerivWS(payload) {
  return new Promise((resolve, reject) => {
    const ws    = new WebSocket(DERIV_WS_URL);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Deriv WS timeout (${DERIV_TIMEOUT}ms) for symbol ${payload.ticks_history || payload.ticks}`));
    }, DERIV_TIMEOUT);

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });

    ws.on('open', () => { ws.send(JSON.stringify({ ...payload, req_id: 1 })); });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.req_id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) {
        reject(new Error(`Deriv API: ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        resolve(msg);
      }
    });
  });
}

// Daily OHLC candles, last 90 bars — matches CoinGecko's lookback window
// so the indicator suite sees a consistent history depth across all asset types.
// Deriv synthetic indices have no volume concept; volumes array is null-filled
// and computeIndicators handles null volume gracefully (OBV will be absent).
async function fetchDerivHistory(derivId) {
  return cached(`deriv-hist-${derivId}`, 5 * 60 * 1000, async () => {
    const msg = await fetchDerivWS({
      ticks_history: derivId,
      adjust_start_time: 1,
      count: 90,
      end: 'latest',
      granularity: 86400,
      style: 'candles',
    });
    const candles = msg.candles || [];
    if (!candles.length) throw new Error(`Deriv: no daily history for ${derivId}`);
    return {
      closes:  candles.map((c) => Number(c.close)),
      highs:   candles.map((c) => Number(c.high)),
      lows:    candles.map((c) => Number(c.low)),
      volumes: candles.map(() => null),
    };
  });
}

// Live tick — 30s TTL is tight enough to be "current" without hammering WS.
async function fetchDerivTick(derivId) {
  return cached(`deriv-tick-${derivId}`, 30 * 1000, async () => {
    const msg  = await fetchDerivWS({ ticks: derivId, subscribe: 0 });
    const tick = msg.tick;
    if (!tick) throw new Error(`Deriv: no tick in response for ${derivId}`);
    return { price: Number(tick.quote), epoch: tick.epoch };
  });
}

// Hourly candles for the last 7 days (168 bars) — used by getMultiTimeframe.
// Synthetic indices are algorithmically generated 24/7, so real hourly data
// exists for all of them unlike exchange-traded assets with market hours gaps.
async function fetchDerivHourly(derivId) {
  return cached(`deriv-hourly-${derivId}`, 5 * 60 * 1000, async () => {
    const msg = await fetchDerivWS({
      ticks_history: derivId,
      adjust_start_time: 1,
      count: 168,
      end: 'latest',
      granularity: 3600,
      style: 'candles',
    });
    const candles = msg.candles || [];
    if (!candles.length) throw new Error(`Deriv: no hourly history for ${derivId}`);
    return {
      closes:  candles.map((c) => Number(c.close)),
      highs:   candles.map((c) => Number(c.high)),
      lows:    candles.map((c) => Number(c.low)),
      volumes: candles.map(() => null),
    };
  });
}

// ════════════════════════════════════════════════════════════════
//  CoinGecko helpers (unchanged)
// ════════════════════════════════════════════════════════════════

async function fetchCryptoHistory(id) {
  return cached(`cg-hist-${id}`, 5 * 60 * 1000, async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=90&interval=daily`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko history ${res.status}`);
    const data = await res.json();
    return {
      closes:  (data.prices        || []).map((p) => p[1]),
      volumes: (data.total_volumes || []).map((v) => v[1]),
    };
  });
}

async function fetchCryptoOHLC(id) {
  return cached(`cg-ohlc-${id}`, 5 * 60 * 1000, async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=90`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko OHLC ${res.status}`);
    const data = await res.json();
    return {
      highs:  data.map((r) => r[2]),
      lows:   data.map((r) => r[3]),
      closes: data.map((r) => r[4]),
    };
  });
}

async function fetchCryptoSnapshot(ids) {
  return cached(`cg-snap-${ids.join(',')}`, 60 * 1000, async () => {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko price ${res.status}`);
    return res.json();
  });
}

// ════════════════════════════════════════════════════════════════
//  Stooq / Yahoo helpers (unchanged)
// ════════════════════════════════════════════════════════════════

function parseStooqCsv(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(',');
    return { date, high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
  }).filter((r) => Number.isFinite(r.close));
}

async function fetchStockHistoryYahoo(symbol) {
  return cached(`yh-hist-${symbol}`, 5 * 60 * 1000, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=6mo&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`Yahoo history ${res.status}`);
    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('Yahoo: no data for symbol');
    const quote   = result.indicators?.quote?.[0] || {};
    const closes  = (quote.close  || []).filter((v) => v != null);
    const highs   = (quote.high   || []).filter((v) => v != null);
    const lows    = (quote.low    || []).filter((v) => v != null);
    const volumes = (quote.volume || []).filter((v) => v != null);
    if (!closes.length) throw new Error('Yahoo: empty series');
    return { closes, volumes, highs, lows, source: 'yahoo' };
  });
}

async function fetchStockHistory(stooqSym) {
  try {
    return await cached(`stq-hist-${stooqSym}`, 5 * 60 * 1000, async () => {
      const url  = `https://stooq.com/q/d/l/?s=${stooqSym}&i=d`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error(`Stooq history ${res.status}`);
      const text = await res.text();
      if (/no data/i.test(text) || text.length < 20) throw new Error('Stooq: no data for symbol');
      const rows = parseStooqCsv(text);
      if (rows.length < 5) throw new Error('Stooq: too few rows');
      return {
        closes:  rows.map((r) => r.close),
        volumes: rows.map((r) => r.volume),
        highs:   rows.map((r) => r.high),
        lows:    rows.map((r) => r.low),
        rows,
        source: 'stooq',
      };
    });
  } catch {
    const plainSym = stooqSym.replace(/\.us$/i, '').toUpperCase();
    const yahoo    = await fetchStockHistoryYahoo(plainSym);
    const rows     = yahoo.closes.map((c, i) => ({
      close: c, high: yahoo.highs[i], low: yahoo.lows[i], volume: yahoo.volumes[i],
    }));
    return { ...yahoo, rows };
  }
}

// ════════════════════════════════════════════════════════════════
//  getSnapshot — crypto / stock / deriv
// ════════════════════════════════════════════════════════════════

async function getSnapshot(symbols) {
  const knownCrypto = symbols.filter((s) => ASSET_MAP[s]?.type === 'crypto');
  const knownStock  = symbols.filter((s) => ASSET_MAP[s]?.type === 'stock');
  const knownDeriv  = symbols.filter((s) => ASSET_MAP[s]?.type === 'deriv');
  const unknown     = symbols.filter((s) => !ASSET_MAP[s]);

  const out = {};

  // ---- Crypto ----
  let cgSnap = {};
  if (knownCrypto.length) {
    try {
      cgSnap = await fetchCryptoSnapshot(knownCrypto.map((s) => ASSET_MAP[s].id));
    } catch (e) {
      knownCrypto.forEach((s) => { out[s] = { ok: false, reason: e.message }; });
    }
  }

  await Promise.all(knownCrypto.map(async (sym) => {
    if (out[sym]) return;
    const id   = ASSET_MAP[sym].id;
    const live = cgSnap[id];
    try {
      const hist   = await fetchCryptoHistory(id);
      const closes = live ? [...hist.closes, live.usd] : hist.closes;
      let highs = null, lows = null;
      try {
        const ohlc = await fetchCryptoOHLC(id);
        const n    = Math.min(ohlc.highs.length, closes.length);
        highs = ohlc.highs.slice(-n);
        lows  = ohlc.lows.slice(-n);
        if (n < closes.length) {
          highs = new Array(closes.length - n).fill(null).concat(highs);
          lows  = new Array(closes.length - n).fill(null).concat(lows);
        }
      } catch { /* ATR/Stochastic omitted */ }
      const hasCleanOhlc = highs && lows && highs.every((v) => v != null) && lows.every((v) => v != null);
      const ind = computeIndicators(closes, hist.volumes, hasCleanOhlc ? highs : null, hasCleanOhlc ? lows : null);
      out[sym] = {
        ok: true, symbol: sym, type: 'crypto',
        price:    live ? live.usd            : ind.close,
        change24h:live ? live.usd_24h_change : null,
        volume24h:live ? live.usd_24h_vol    : null,
        ...ind, updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      out[sym] = { ok: false, reason: e.message, symbol: sym, type: 'crypto' };
    }
  }));

  // ---- Stocks ----
  await Promise.all(knownStock.map(async (sym) => {
    const stooqSym = ASSET_MAP[sym].id;
    try {
      const hist      = await fetchStockHistory(stooqSym);
      if (!hist.closes.length) throw new Error('no rows');
      const ind       = computeIndicators(hist.closes, hist.volumes, hist.highs, hist.lows);
      const rows      = hist.rows;
      const prevClose = rows.length > 1 ? rows[rows.length - 2].close : null;
      const change24h = prevClose ? ((ind.close - prevClose) / prevClose) * 100 : null;
      out[sym] = {
        ok: true, symbol: sym, type: 'stock',
        price: ind.close, change24h, volume24h: rows[rows.length - 1].volume,
        ...ind, updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      out[sym] = {
        ok: false,
        reason: `${e.message} (tried Stooq and Yahoo fallback — both unavailable right now; free data can be delayed/unavailable outside US market data licensing)`,
        symbol: sym, type: 'stock',
      };
    }
  }));

  // ---- Deriv synthetic indices ----
  // Fetches daily OHLC history + live tick in parallel.
  // The live tick is tail-appended to the close series (same pattern as
  // crypto) so computeIndicators sees the freshest price as its last data
  // point. Volumes are null for all Deriv synthetics — they are
  // algorithmically generated, not order-flow driven, so OBV is omitted.
  await Promise.all(knownDeriv.map(async (sym) => {
    const { id, display } = ASSET_MAP[sym];
    try {
      const [hist, tick] = await Promise.all([fetchDerivHistory(id), fetchDerivTick(id)]);

      // Tail-append the live tick price. For highs/lows of the appended
      // point we use the tick price itself — a single intraday point has
      // no meaningful H/L spread, but it keeps the arrays length-aligned
      // so ATR/Stochastic remain valid on the historical portion.
      const closes = [...hist.closes, tick.price];
      const highs  = [...hist.highs,  tick.price];
      const lows   = [...hist.lows,   tick.price];

      const prevClose = hist.closes.length ? hist.closes[hist.closes.length - 1] : null;
      const change24h = prevClose ? ((tick.price - prevClose) / prevClose) * 100 : null;

      const ind = computeIndicators(closes, hist.volumes, highs, lows);

      out[sym] = {
        ok: true, symbol: sym, type: 'deriv', display,
        price: tick.price, change24h,
        volume24h: null, // no volume for synthetic indices
        ...ind,
        note: 'Deriv synthetic index — algorithmically generated, not exchange-traded. Volume data unavailable.',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      out[sym] = {
        ok: false,
        reason: `${e.message} (Deriv WS API — confirm the symbol is active at ws.derivws.com)`,
        symbol: sym, type: 'deriv', display,
      };
    }
  }));

  unknown.forEach((sym) => {
    out[sym] = { ok: false, reason: 'Unknown symbol — not in the supported asset map.', symbol: sym };
  });

  return out;
}

// ════════════════════════════════════════════════════════════════
//  getHistory — extended for Deriv
// ════════════════════════════════════════════════════════════════

async function getHistory(symbol) {
  const entry = ASSET_MAP[symbol];
  if (!entry) return { ok: false, reason: 'Unknown symbol.' };
  try {
    if (entry.type === 'crypto') {
      const hist = await fetchCryptoHistory(entry.id);
      let highs = null, lows = null;
      try {
        const ohlc = await fetchCryptoOHLC(entry.id);
        const n = Math.min(ohlc.highs.length, hist.closes.length);
        if (n === hist.closes.length) { highs = ohlc.highs.slice(-n); lows = ohlc.lows.slice(-n); }
      } catch { /* highs/lows optional for backtest */ }
      return { ok: true, symbol, type: 'crypto', closes: hist.closes, volumes: hist.volumes, highs, lows };
    }
    if (entry.type === 'stock') {
      const hist = await fetchStockHistory(entry.id);
      return { ok: true, symbol, type: 'stock', closes: hist.closes, volumes: hist.volumes, highs: hist.highs, lows: hist.lows };
    }
    if (entry.type === 'deriv') {
      const hist = await fetchDerivHistory(entry.id);
      return {
        ok: true, symbol, type: 'deriv',
        closes: hist.closes, volumes: hist.volumes, highs: hist.highs, lows: hist.lows,
        note: 'Deriv synthetic — volume is null throughout (no order flow).',
      };
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ════════════════════════════════════════════════════════════════
//  getMultiTimeframe — extended for Deriv
// ════════════════════════════════════════════════════════════════

function resample(values, factor) {
  const out = [];
  for (let i = values.length % factor; i < values.length; i += factor) out.push(values[i]);
  return out;
}

async function fetchCryptoHourly(id) {
  return cached(`cg-hourly-${id}`, 5 * 60 * 1000, async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko hourly ${res.status}`);
    const data = await res.json();
    return {
      closes:  (data.prices        || []).map((p) => p[1]),
      volumes: (data.total_volumes || []).map((v) => v[1]),
    };
  });
}

async function getMultiTimeframe(symbol) {
  const entry = ASSET_MAP[symbol];
  if (!entry) return { ok: false, reason: 'Unknown symbol.' };

  if (entry.type === 'stock') {
    try {
      const hist = await fetchStockHistory(entry.id);
      const ind  = computeIndicators(hist.closes, hist.volumes, hist.highs, hist.lows);
      return {
        ok: true, symbol,
        note: "Daily only — Stooq doesn't provide reliable intraday bars for stocks.",
        timeframes: { '1d': ind.confluence },
      };
    } catch (e) { return { ok: false, reason: e.message }; }
  }

  if (entry.type === 'deriv') {
    // Synthetic indices trade 24/7 with no market-hours gaps — real
    // hourly and 4h candles are available for all of them.
    try {
      const [hourly, daily] = await Promise.all([
        fetchDerivHourly(entry.id),
        fetchDerivHistory(entry.id),
      ]);
      const ind1h    = computeIndicators(hourly.closes, hourly.volumes, hourly.highs, hourly.lows);
      const closes4h = resample(hourly.closes, 4);
      const highs4h  = resample(hourly.highs,  4);
      const lows4h   = resample(hourly.lows,   4);
      const vol4h    = resample(hourly.volumes, 4);
      const ind4h    = computeIndicators(closes4h, vol4h, highs4h, lows4h);
      const ind1d    = computeIndicators(daily.closes, daily.volumes, daily.highs, daily.lows);
      const timeframes = { '1h': ind1h?.confluence, '4h': ind4h?.confluence, '1d': ind1d?.confluence };
      const trendLeans = Object.values(timeframes).filter(Boolean)
        .map((c) => c.readings.find((r) => r.indicator === 'sma_trend')?.lean);
      const allAgree = trendLeans.length === 3
        && trendLeans.every((l) => l === trendLeans[0])
        && trendLeans[0] !== 'flat';
      return { ok: true, symbol, timeframes, trendAgreement: allAgree ? trendLeans[0] : 'mixed' };
    } catch (e) { return { ok: false, reason: e.message }; }
  }

  // Crypto (unchanged)
  try {
    const [hourly, daily] = await Promise.all([fetchCryptoHourly(entry.id), fetchCryptoHistory(entry.id)]);
    const ind1h    = computeIndicators(hourly.closes, hourly.volumes);
    const closes4h = resample(hourly.closes, 4);
    const vol4h    = resample(hourly.volumes, 4);
    const ind4h    = computeIndicators(closes4h, vol4h);
    const ind1d    = computeIndicators(daily.closes, daily.volumes);
    const timeframes = { '1h': ind1h?.confluence, '4h': ind4h?.confluence, '1d': ind1d?.confluence };
    const trendLeans = Object.values(timeframes).filter(Boolean)
      .map((c) => c.readings.find((r) => r.indicator === 'sma_trend')?.lean);
    const allAgree = trendLeans.length === 3
      && trendLeans.every((l) => l === trendLeans[0])
      && trendLeans[0] !== 'flat';
    return { ok: true, symbol, timeframes, trendAgreement: allAgree ? trendLeans[0] : 'mixed' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ════════════════════════════════════════════════════════════════
//  getMultiHistory (unchanged — Deriv routed via getHistory)
// ════════════════════════════════════════════════════════════════

async function getMultiHistory(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    const h = await getHistory(sym);
    if (h.ok) out[sym] = h.closes;
  }));
  return out;
}

module.exports = { ASSET_MAP, getSnapshot, getHistory, getMultiHistory, getMultiTimeframe, stockSymbolFor };
