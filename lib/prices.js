const { computeIndicators } = require('./indicators');

// Symbol -> data-source mapping. Crypto goes through CoinGecko (free, no
// key). Stocks go through Stooq's public CSV endpoints (free, no key,
// ~15-20min delayed — fine for a triage dashboard, not for order timing).
const ASSET_MAP = {
  BTC: { type: 'crypto', id: 'bitcoin' },
  ETH: { type: 'crypto', id: 'ethereum' },
  SOL: { type: 'crypto', id: 'solana' },
  DOGE: { type: 'crypto', id: 'dogecoin' },
  TSLA: { type: 'stock', id: 'tsla.us' },
  AAPL: { type: 'stock', id: 'aapl.us' },
  NVDA: { type: 'stock', id: 'nvda.us' },
  MSFT: { type: 'stock', id: 'msft.us' },
  AMZN: { type: 'stock', id: 'amzn.us' },
  META: { type: 'stock', id: 'meta.us' },
  GOOGL: { type: 'stock', id: 'googl.us' },
};

function stockSymbolFor(sym) {
  return sym.toLowerCase().includes('.') ? sym.toLowerCase() : `${sym.toLowerCase()}.us`;
}

// ---- tiny in-memory cache so a burst of requests doesn't hammer either API ----
const cache = new Map(); // key -> { at, ttlMs, data }
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), ttlMs, data });
  return data;
}

async function fetchCryptoHistory(id) {
  return cached(`cg-hist-${id}`, 5 * 60 * 1000, async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=90&interval=daily`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko history ${res.status}`);
    const data = await res.json();
    const closes = (data.prices || []).map((p) => p[1]);
    const volumes = (data.total_volumes || []).map((v) => v[1]);
    return { closes, volumes };
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

function parseStooqCsv(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  const rows = lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(',');
    return { date, close: Number(close), volume: Number(volume) };
  }).filter((r) => Number.isFinite(r.close));
  return rows;
}

async function fetchStockHistory(stooqSym) {
  return cached(`stq-hist-${stooqSym}`, 5 * 60 * 1000, async () => {
    const url = `https://stooq.com/q/d/l/?s=${stooqSym}&i=d`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Stooq history ${res.status}`);
    const text = await res.text();
    if (/no data/i.test(text) || text.length < 20) throw new Error('Stooq: no data for symbol');
    const rows = parseStooqCsv(text);
    return { closes: rows.map((r) => r.close), volumes: rows.map((r) => r.volume), rows };
  });
}

/**
 * Builds a full snapshot (current price + indicator set) for every symbol
 * in `symbols`. Best-effort per symbol — one failing doesn't drop the rest.
 */
async function getSnapshot(symbols) {
  const knownCrypto = symbols.filter((s) => ASSET_MAP[s] && ASSET_MAP[s].type === 'crypto');
  const knownStock = symbols.filter((s) => ASSET_MAP[s] && ASSET_MAP[s].type === 'stock');
  const unknown = symbols.filter((s) => !ASSET_MAP[s]);

  const out = {};
  let cgSnap = {};
  if (knownCrypto.length) {
    try {
      cgSnap = await fetchCryptoSnapshot(knownCrypto.map((s) => ASSET_MAP[s].id));
    } catch (e) {
      knownCrypto.forEach((s) => { out[s] = { ok: false, reason: e.message }; });
    }
  }

  await Promise.all(knownCrypto.map(async (sym) => {
    if (out[sym]) return; // already errored above
    const id = ASSET_MAP[sym].id;
    const live = cgSnap[id];
    try {
      const hist = await fetchCryptoHistory(id);
      const closes = live ? [...hist.closes, live.usd] : hist.closes;
      const ind = computeIndicators(closes, hist.volumes);
      out[sym] = {
        ok: true,
        symbol: sym,
        type: 'crypto',
        price: live ? live.usd : ind.close,
        change24h: live ? live.usd_24h_change : null,
        volume24h: live ? live.usd_24h_vol : null,
        ...ind,
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      out[sym] = { ok: false, reason: e.message, symbol: sym, type: 'crypto' };
    }
  }));

  await Promise.all(knownStock.map(async (sym) => {
    const stooqSym = ASSET_MAP[sym].id;
    try {
      const hist = await fetchStockHistory(stooqSym);
      if (!hist.closes.length) throw new Error('no rows');
      const ind = computeIndicators(hist.closes, hist.volumes);
      const rows = hist.rows;
      const prevClose = rows.length > 1 ? rows[rows.length - 2].close : null;
      const change24h = prevClose ? ((ind.close - prevClose) / prevClose) * 100 : null;
      out[sym] = {
        ok: true,
        symbol: sym,
        type: 'stock',
        price: ind.close,
        change24h,
        volume24h: rows[rows.length - 1].volume,
        ...ind,
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      out[sym] = { ok: false, reason: `${e.message} (Stooq — data can be delayed/unavailable outside US market data licensing)`, symbol: sym, type: 'stock' };
    }
  }));

  unknown.forEach((sym) => {
    out[sym] = { ok: false, reason: 'Unknown symbol — not in the supported asset map.', symbol: sym };
  });

  return out;
}

async function getHistory(symbol) {
  const entry = ASSET_MAP[symbol];
  if (!entry) return { ok: false, reason: 'Unknown symbol.' };
  try {
    if (entry.type === 'crypto') {
      const hist = await fetchCryptoHistory(entry.id);
      return { ok: true, symbol, type: 'crypto', closes: hist.closes };
    }
    const hist = await fetchStockHistory(entry.id);
    return { ok: true, symbol, type: 'stock', closes: hist.closes };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { ASSET_MAP, getSnapshot, getHistory, stockSymbolFor };
