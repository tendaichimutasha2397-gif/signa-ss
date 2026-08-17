const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const enabled = Boolean(YOUTUBE_API_KEY);

/**
 * Searches YouTube for videos that might relate to a given headline/figure.
 * This is a best-effort search, not a verified match — the caller is
 * responsible for presenting results as "possible related videos," never as
 * confirmed footage of the statement in question. Auto-matching a headline
 * to "the" correct clip isn't reliable, and presenting a guess as confirmed
 * would be worse than not showing a video at all.
 */
async function searchVideos(query, { publishedAfter, max = 4 } = {}) {
  if (!enabled) return { ok: false, reason: 'YOUTUBE_API_KEY not set on the server.' };
  if (!query || !query.trim()) return { ok: false, reason: 'Empty search query.' };

  try {
    const params = new URLSearchParams({
      key: YOUTUBE_API_KEY,
      part: 'snippet',
      type: 'video',
      order: 'relevance',
      maxResults: String(Math.min(max, 8)),
      q: query,
      relevanceLanguage: 'en',
      safeSearch: 'moderate',
    });
    if (publishedAfter) params.set('publishedAfter', publishedAfter);

    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: `YouTube API error ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const items = (data.items || [])
      .filter((it) => it.id && it.id.videoId)
      .map((it) => ({
        videoId: it.id.videoId,
        title: it.snippet.title,
        channel: it.snippet.channelTitle,
        publishedAt: it.snippet.publishedAt,
        thumbnail: it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default || {}).url,
        url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      }));
    return { ok: true, items };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { enabled, searchVideos };
