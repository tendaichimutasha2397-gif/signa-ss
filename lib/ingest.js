const crypto = require('crypto');
const Parser = require('rss-parser');
const { ALL_SOURCES } = require('./sources');
const { scoreItem } = require('./scorer');
const db = require('./db');

const parser = new Parser({ timeout: 15000 });

function makeId(link, title) {
  return crypto.createHash('sha1').update(`${link || ''}::${title || ''}`).digest('hex');
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return (feed.items || []).map((raw) => {
      const link = raw.link || raw.guid || '';
      const title = raw.title || '(untitled)';
      return {
        id: makeId(link, title),
        title,
        link,
        summary: stripHtml(raw.contentSnippet || raw.content || raw.summary || ''),
        source: source.name,
        sourceId: source.id,
        category: source.category === 'spotlight' ? 'stocks' : source.category, // spotlight is a tag, not a hard category
        publishedAt: raw.isoDate || raw.pubDate || new Date().toISOString(),
      };
    });
  } catch (e) {
    console.warn(`[ingest] ${source.name} failed: ${e.message}`);
    return [];
  }
}

/**
 * Fetches every source in parallel (best-effort — one failing doesn't block
 * the rest), scores each new item against the current watchlist, and stores
 * anything not already seen. Returns the newly added, scored items.
 */
async function runIngestCycle() {
  const watchlist = db.getWatchlist();
  const results = await Promise.all(ALL_SOURCES.map(fetchSource));
  const rawItems = results.flat();
  const scored = rawItems.map((item) => scoreItem(item, watchlist));
  const added = db.addItems(scored);
  return added;
}

module.exports = { runIngestCycle };
