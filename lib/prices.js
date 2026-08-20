const { computeIndicators } = require('./indicators');

// Symbol -> data-source mapping. Crypto goes through CoinGecko (free, no
// key). Stocks go through Stooq's public CSV endpoints (free, no key,
// ~15-20min delayed — fine for a triage dashboard, not for order timing).
const ASSET_MAP = {
  // -- crypto (CoinGecko) --
  BTC: { type: 'crypto', id: 'bitcoin' },
  ETH: { type: 'crypto', id: 'ethereum' },
  SOL: { type: 'crypto', id: 'solana' },
  DOGE: { type: 'crypto', id: 'dogecoin' },
  XRP: { type: 'crypto', id: 'ripple' },
  ADA: { type: 'crypto', id: 'cardano' },
  AVAX: { type: 'crypto', id: 'avalanche-2' },
  LINK: { type: 'crypto', id: 'chainlink' },
  MATIC: { type: 'crypto', id: 'matic-network' },
  LTC: { type: 'crypto', id: 'litecoin' },
  DOT: { type: 'crypto', id: 'polkadot' },
  BNB: { type: 'crypto', id: 'binancecoin' },
  // -- stocks (Stooq) --
  TSLA: { type: 'stock', id: 'tsla.us' },
  AAPL: { type: 'stock', id: 'aapl.us' },
  NVDA: { type: 'stock', id: 'nvda.us' },
  MSFT: { type: 'stock', id: 'msft.us' },
  AMZN: { type: 'stock', id: 'amzn.us' },
  META: { type: 'stock', id: 'meta.us' },
  GOOGL: { type: 'stock', id: 'googl.us' },
  NFLX: { type: 'stock', id: 'nflx.us' },
  AMD: { type: 'stock', id: 'amd.us' },
  INTC: { type: 'stock', id: 'intc.us' },
  JPM: { type: 'stock', id: 'jpm.us' },
  BAC: { type: 'stock', id: 'bac.us' },
  DIS: { type: 'stock', id: 'dis.us' },
  COIN: { type: 'stock', id: 'coin.us' },
  PLTR: { type: 'stock', id: 'pltr.us' },
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

// CoinGecko's dedicated OHLC endpoint — needed for ATR/Stochastic, which
// require real highs/lows (not derivable from close-only data). Daily
// granularity at days=90 to match fetchCryptoHistory's window.
async function fetchCryptoOHLC(id) {
  return cached(`cg-ohlc-${id}`, 5 * 60 * 1000, async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=90`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko OHLC ${res.status}`);
    const data = await res.json();
    // Each row: [timestamp, open, high, low, close]
    return {
      highs: data.map((r) => r[2]),
      lows: data.map((r) => r[3]),
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

function parseStooqCsv(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  const rows = lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume] = line.split(',');
    return { date, high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) };
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
    return {
      closes: rows.map((r) => r.close),
      volumes: rows.map((r) => r.volume),
      highs: rows.map((r) => r.high),
      lows: rows.map((r) => r.low),
      rows,
    };
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
      // ATR/Stochastic need real highs/lows — fetch the OHLC endpoint
      // separately and tail-align it to `closes`. Best-effort: if it fails
      // or lengths don't line up cleanly, computeIndicators just omits
      // those two indicators rather than approximating from close-only data.
      let highs = null;
      let lows = null;
      try {
        const ohlc = await fetchCryptoOHLC(id);
        const n = Math.min(ohlc.highs.length, closes.length);
        highs = ohlc.highs.slice(-n);
        lows = ohlc.lows.slice(-n);
        if (n < closes.length) {
          // pad the front with nulls so array length still matches `closes`
          // (computeIndicators requires equal length to trust highs/lows)
          highs = new Array(closes.length - n).fill(null).concat(highs);
          lows = new Array(closes.length - n).fill(null).concat(lows);
        }
      } catch (e) {
        // ATR/Stochastic simply won't be present in this snapshot — fine.
      }
      const hasCleanOhlc = highs && lows && highs.every((v) => v != null) && lows.every((v) => v != null);
      const ind = computeIndicators(closes, hist.volumes, hasCleanOhlc ? highs : null, hasCleanOhlc ? lows : null);
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
      const ind = computeIndicators(hist.closes, hist.volumes, hist.highs, hist.lows);
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

// Hourly crypto series (CoinGecko returns automatic hourly granularity for
// a 2-90 day window when no explicit interval is requested).
async function fetchCryptoHourly(id) {
  return cached(`cg-hourly-${id}`, 5 * 60 * 1000, async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CoinGecko hourly ${res.status}`);
    const data = await res.json();
    return { closes: (data.prices || []).map((p) => p[1]), volumes: (data.total_volumes || []).map((v) => v[1]) };
  });
}

// Downsamples an hourly series into 4-hour buckets by taking every 4th
// close — a simple resample, not a true 4h-candle aggregation, but close
// enough for a reference-only multi-timeframe view.
function resample(values, factor) {
  const out = [];
  for (let i = values.length % factor; i < values.length; i += factor) out.push(values[i]);
  return out;
}

/**
 * Computes indicator confluence at multiple timeframes for one symbol, so
 * you can see whether shorter and longer horizons agree or disagree.
 * Crypto gets real 1h/4h/1d data from CoinGecko. Stocks are limited to
 * daily — Stooq's free tier doesn't offer reliable intraday bars, and this
 * app doesn't fake that with a paid feed, so the response says so plainly
 * instead of pretending to have hourly stock data it doesn't have.
 */
async function getMultiTimeframe(symbol) {
  const entry = ASSET_MAP[symbol];
  if (!entry) return { ok: false, reason: 'Unknown symbol.' };

  if (entry.type === 'stock') {
    try {
      const hist = await fetchStockHistory(entry.id);
      const ind = computeIndicators(hist.closes, hist.volumes, hist.highs, hist.lows);
      return {
        ok: true,
        symbol,
        note: 'Daily only — this app\'s free stock data source (Stooq) doesn\'t provide reliable intraday bars, so 1h/4h views aren\'t available for stocks here.',
        timeframes: { '1d': ind.confluence },
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  try {
    const [hourly, daily] = await Promise.all([fetchCryptoHourly(entry.id), fetchCryptoHistory(entry.id)]);
    const ind1h = computeIndicators(hourly.closes, hourly.volumes);
    const closes4h = resample(hourly.closes, 4);
    const vol4h = resample(hourly.volumes, 4);
    const ind4h = computeIndicators(closes4h, vol4h);
    const ind1d = computeIndicators(daily.closes, daily.volumes);
    const timeframes = { '1h': ind1h?.confluence, '4h': ind4h?.confluence, '1d': ind1d?.confluence };
    // Agreement: does the SMA-trend lean (up/down/flat) match across all
    // three timeframes? A count, same spirit as the single-timeframe
    // confluence — not a verdict, just whether horizons agree.
    const trendLeans = Object.values(timeframes).filter(Boolean).map((c) => c.readings.find((r) => r.indicator === 'sma_trend')?.lean);
    const allAgree = trendLeans.length === 3 && trendLeans.every((l) => l === trendLeans[0]) && trendLeans[0] !== 'flat';
    return { ok: true, symbol, timeframes, trendAgreement: allAgree ? trendLeans[0] : 'mixed' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { ASSET_MAP, getSnapshot, getHistory, getMultiTimeframe, stockSymbolFor };
