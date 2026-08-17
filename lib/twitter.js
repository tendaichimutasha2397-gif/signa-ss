const crypto = require('crypto');
const { scoreItem } = require('./scorer');
const db = require('./db');

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const enabled = Boolean(X_BEARER_TOKEN);

// Accounts always included in the X query on top of whatever the watchlist
// contains, since these are the two the user specifically wants front and
// center. Handles only — no need for display-name aliasing here.
const CORE_HANDLES = ['realDonaldTrump', 'elonmusk'];

function buildQuery(watchlist) {
  const handleTerms = CORE_HANDLES.map((h) => `from:${h}`);
  // Keep the query focused on market-relevant posts from tracked accounts,
  // plus a general market-keyword search so non-tracked breaking posts surface too.
  const marketTerms = '(stock OR stocks OR crypto OR bitcoin OR market OR Nasdaq OR "S&P")';
  return `(${handleTerms.join(' OR ')}) OR (${marketTerms} -is:retweet)`;
}

async function fetchRecentPosts(watchlist) {
  if (!enabled) return { ok: false, reason: 'X_BEARER_TOKEN not set on the server.' };
  try {
    const query = encodeURIComponent(buildQuery(watchlist));
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=25&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,name`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` } });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: `X API error ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const users = {};
    (data.includes && data.includes.users || []).forEach((u) => { users[u.id] = u; });
    const items = (data.data || []).map((tweet) => {
      const user = users[tweet.author_id] || {};
      const link = user.username ? `https://x.com/${user.username}/status/${tweet.id}` : `https://x.com/i/status/${tweet.id}`;
      return {
        id: crypto.createHash('sha1').update(`x:${tweet.id}`).digest('hex'),
        title: tweet.text,
        link,
        summary: '',
        source: user.name ? `X — ${user.name}` : 'X',
        sourceId: 'x-live',
        category: 'social',
        publishedAt: tweet.created_at || new Date().toISOString(),
      };
    });
    return { ok: true, items: items.map((item) => scoreItem(item, watchlist)) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function runTwitterIngestCycle() {
  if (!enabled) return [];
  const watchlist = db.getWatchlist();
  const result = await fetchRecentPosts(watchlist);
  if (!result.ok) {
    console.warn(`[twitter] ${result.reason}`);
    return [];
  }
  return db.addItems(result.items);
}

module.exports = { enabled, runTwitterIngestCycle };
