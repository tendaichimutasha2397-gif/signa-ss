# Market Pulse

A live dashboard that aggregates stock and crypto news, spotlights anything
from a tracked list of public figures (defaults to Trump and Musk, fully
editable in the UI), and surfaces video where it genuinely exists.

## ⚠ Folder structure matters

This only runs if `lib/` and `public/` stay as real subfolders — not files
sitting loose next to `server.js`. It should look exactly like this:

```
market-pulse/
├── package.json
├── railway.json
├── README.md
├── server.js
├── lib/
│   ├── db.js
│   ├── ingest.js
│   ├── scorer.js
│   ├── sources.js
│   ├── twitter.js
│   └── youtube.js
└── public/
    └── index.html
```

If you're uploading to GitHub through the browser, drag the whole `lib` and
`public` **folders** into the upload box — not the individual files inside
them — or GitHub will flatten everything and the app will crash with
`Cannot find module './lib/db'`.

## Prices & indicators

The dashboard shows a live price panel for a tracked list of assets
(default: BTC, ETH, SOL, TSLA, AAPL, NVDA — add/remove any of the symbols
in `lib/prices.js`'s `ASSET_MAP`). For each one it shows:

- Current price and 24h % change, plus a 30-point sparkline
- **RSI(14)**, **Stochastic %K/%D**, **Williams %R**, **CCI** — four
  differently-scaled "where does price sit in its recent range" readings
- **SMA20/SMA50 trend** and **ADX/+DI/-DI** — direction vs. trend *strength*
  are genuinely different axes; ADX flags whether a trend is even present
  before direction is worth much
- **MACD histogram** and **OBV trend** (volume-confirmed momentum)
- **Bollinger Bands** position and **VWAP(20)** (volume-weighted average price)
- **Ichimoku Cloud** position (above/inside/below) and Tenkan/Kijun cross
- **Fibonacci retracement levels** over the trailing swing (via the "Fib
  levels" button on each card)
- **ATR(14)** and a **volatility regime** read — is this asset's current
  ATR unusually high or low versus its own recent history (percentile-based)
- **Volume spike** flag (current volume vs. its recent average)
- A **confluence tally** — a transparent count of how many of the above are
  currently leaning up/down/flat, with every individual reading inspectable

Crypto prices/history come from CoinGecko's free public API (no key
needed). Stock prices/history come from Stooq's free CSV endpoints first,
falling back automatically to Yahoo Finance's public chart endpoint if
Stooq is unavailable — two independent free sources for resilience. Both
are **delayed** — not real-time, and not licensed market data.

### Correlation matrix

A panel below the price grid computes the Pearson correlation of daily
returns across every currently-tracked asset, shown as a full matrix plus
the most- and least-correlated pairs. This is real statistics about how
closely assets have moved together — useful for spotting where a "tracked
list" is actually diversified vs. secretly one bet six times over. It's a
historical snapshot; correlations shift over time and tend to rise across
the board in risk-off periods, which the panel says explicitly.

### Backtesting — now with OR logic and walk-forward validation

The per-asset "Backtest a rule" button lets you check any condition (or
several, OR'd together — add rows for "if RSI < 30 OR Stoch %K < 20") against
the asset's available history, reporting how often price was up/down/flat
some number of days later. New: a **walk-forward check** splits that same
history into sequential time periods and reports the hit-rate independently
per period, so you can see whether a pattern held up consistently over time
or was really just one lucky/unlucky stretch driving the headline number.
Metrics available: RSI, SMA20/50, MACD histogram, Bollinger bands, close,
Stochastic %K, ADX, +DI/-DI, CCI, Williams %R, OBV.

**"Indicator alerts"** fire (in-app + optional browser notification, same
toggle as figure alerts) when one of these *changes state* — e.g. RSI just
crossed into overbought, the 20/50-day averages just crossed. These are
plain descriptions of what the indicator did, not predictions or trade
calls, and each one carries a one-line caveat saying so.

### Why this doesn't (and won't) tell you when to buy/sell

Nothing — not this tool, not a paid one — can reliably tell you exactly
when to buy or sell and be "accurate." Indicators like RSI and moving
averages are lagging descriptions of price history, not predictions;
treating a crossover as a signal to act is a common way to lose money,
because by the time an indicator confirms a trend, a lot of the move is
often already priced in. This dashboard surfaces the same rule-based
indicators any charting platform shows you, clearly labeled, so you can
build your own judgment — it deliberately does not synthesize them into a
single "buy now" / "sell now" call, because that call would be a guess
dressed up as certainty.

### MetaTrader 5

This app has no MT5 integration and doesn't place trades on any platform —
it's a read-only research/triage dashboard. MT5 has its own API (Python
package `MetaTrader5`, or MQL5 Expert Advisors) for actually executing
orders; that's a separate system from this one and isn't something I've
wired up here, since doing so in service of "accurate" auto-signals would
just be automating the same unreliable premise above.

## Any-symbol tracker (TradingView)

The price panel above is limited to the fixed list in `lib/prices.js`'s
`ASSET_MAP` (CoinGecko/Stooq-backed, needed for the custom RSI/SMA/MACD
indicators). The separate **"Any-symbol tracker"** panel removes that
limit: it embeds TradingView's own official widgets, so it can show
literally any symbol TradingView covers — stocks on any exchange, crypto
pairs, forex, indices, futures, commodities — not just the small tracked
list.

For each symbol you add you get:
- TradingView's live, interactive chart widget
- TradingView's own **Technical Analysis** gauge — their mechanical
  Buy/Sell/Neutral summary, aggregated from standard moving averages and
  oscillators. This is TradingView's data and TradingView's computation,
  displayed as-is and clearly attributed as theirs — this app doesn't
  compute or claim its own signal on top of it.
- A ticker tape strip across the top of the panel for everything you're tracking

Tracked symbols are stored server-side (like the figure watchlist), so
they're shared across anyone visiting the dashboard. Format: plain tickers
like `AAPL` usually resolve; crypto/forex need an exchange prefix, e.g.
`BINANCE:BTCUSDT`, `FX:EURUSD`, `OANDA:XAUUSD`.

**This still won't tell you when to buy or sell.** The gauge is a reading
of what standard indicators say *right now* — not a prediction, and not
personalized. No indicator, gauge, or combination of them reliably calls
entries/exits; anything that claimed otherwise would be selling you false
confidence with real money on the line.

## What this actually does — and doesn't

**News:** direct RSS from CNBC, MarketWatch, Yahoo Finance, Investing.com,
Benzinga, CoinDesk, Cointelegraph, Decrypt, and The Block, plus several
Google News RSS search queries — Google News' search itself indexes
thousands of publishers (Bloomberg, Reuters, Fox Business, AP, and more), so
between the two you get very broad coverage, usually within minutes of
publication. New items push to the dashboard live over Server-Sent Events.

**Video — X/Twitter posts:** when a tracked account's post has video, the
card's "Show post" button renders the real, official embedded post straight
from X's own widget — the actual clip, from the actual account. This needs
`X_BEARER_TOKEN` (see below) to have posts ingested in the first place.

**Video — everything else ("Find video" button):** searches YouTube for
clips that might relate to a headline. These are **unverified candidates**,
clearly labeled as such — there's no reliable way to auto-confirm that a
given YouTube video is actually footage of a specific statement in a
headline, and presenting a guess as confirmed would be worse than not
showing anything. Needs `YOUTUBE_API_KEY` (see below).

**What it doesn't do:** tap into live cable-news audio/video directly.
There's no consumer-accessible API for that — the closest thing (broadcast
transcript licensing from providers like TVEyes) costs real enterprise
money. In practice this rarely matters since on-air market statements get
written up (and usually clipped to YouTube/X) within minutes.

## 1. Install

```bash
cd market-pulse
npm install
```

## 2. Configure (all optional — the app works with none of these set)

Create a `.env` file in the project root, or set the same variables in
Railway's **Settings → Variables**:

```
# Enables live X/Twitter search + real video embeds for tracked-account posts.
# Get one at developer.x.com — the free tier does NOT include search, you
# need at least the paid Basic tier (~$100/mo at time of writing).
X_BEARER_TOKEN=

# Enables the "Find video" button (YouTube candidate search).
# Get a free key at console.cloud.google.com → enable "YouTube Data API v3"
# → Credentials → API key. Free quota is generous for personal use
# (10,000 units/day; each search costs 100, so ~100 searches/day free).
YOUTUBE_API_KEY=

# Optional — how often to poll (milliseconds). Defaults shown.
NEWS_POLL_MS=180000
TWITTER_POLL_MS=60000
```

## 3. Run locally

```bash
npm start
```

Visit `http://localhost:3000`.

## 4. Deploy on Railway

1. Push this folder to a GitHub repo (see the folder-structure warning above).
2. Railway → **New Project → Deploy from GitHub repo**.
3. Nixpacks detects Node automatically; `railway.json` already points it at `npm start`.
4. Add `X_BEARER_TOKEN` / `YOUTUBE_API_KEY` (if you have them) under **Settings → Variables**.
5. Railway gives you a public URL once it builds.

## How the spotlight & "mover" flag work

- **Tracked figures** (chips at the top) are matched against each
  headline/summary by name and alias, case-insensitively. Add or remove
  people anytime — stored server-side, so it's the same for anyone visiting
  the dashboard, not per-browser.
- **Assets** — known tickers/coin names (BTC, ETH, TSLA, etc.) plus any
  `$TICKER` pattern get tagged automatically.
- **⚡ possible market mover** is a keyword heuristic — a fast triage signal,
  not sentiment analysis or a guarantee.
- **Keyword filter** box does a live client-side search across title,
  summary, figures, and assets on whatever's currently loaded.
- **Notifications** — the checkbox in the filters panel asks for browser
  notification permission and pops one for every new spotlighted item as it
  arrives live.

## Notes on reliability

Every source is fetched independently and best-effort — if one is slow or
temporarily blocking requests, the others still come through. RSS feed URLs
occasionally change on the publisher's end; if a source stops showing new
items, check `lib/sources.js`.

This is a triage and information tool, not financial advice, and it doesn't
execute any trades — it only surfaces and tags information for you to
review.
