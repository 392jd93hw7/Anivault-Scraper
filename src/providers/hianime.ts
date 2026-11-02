import axios from 'axios';
import * as cheerio from 'cheerio';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = (process.env.HIANIME_BASE_URL || 'https://hianime.at').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const client = axios.create({
  baseURL: BASE,
  timeout: 15000,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Referer: BASE + '/' },
});

export interface HiAnimeEpisode { id: string; num: number; title: string; }
export interface HiAnimeServer { name: string; sourceId: string; type: 'sub' | 'dub' | 'raw'; }
export interface HiAnimeSearchResult { id: string; title: string; image: string | null; }

function absolute(value: string): string {
  return new URL(value, BASE).toString();
}

function pathname(value: string): string {
  try { return new URL(value, BASE).pathname.replace(/^\//, ''); }
  catch { return ''; }
}

/** Search the configured HiAnime-compatible site. Set HIANIME_BASE_URL when its domain changes. */
export async function searchHiAnime(query: string): Promise<HiAnimeSearchResult[]> {
  const key = 'hianime:search:' + query.toLowerCase().trim();
  const cached = cacheGet<HiAnimeSearchResult[]>(key);
  if (cached) return cached;
  const { data } = await client.get('/search', { params: { keyword: query } });
  const $ = cheerio.load(data);
  const items: HiAnimeSearchResult[] = [];
  $('.flw-item, .film_list-wrap .item, .ani.items .item').each((_, el) => {
    const root = $(el);
    const a = root.find('a[href*="/watch/"]').first();
    const href = a.attr('href') || '';
    const id = pathname(href).match(/^watch\/([^/]+)/)?.[1] || '';
    const title = root.find('.film-name, .name, .d-title').first().text().trim() || a.attr('title') || '';
    const image = root.find('img').first().attr('data-src') || root.find('img').first().attr('src') || null;
    if (id && title) items.push({ id, title, image: image ? absolute(image) : null });
  });
  const unique = Array.from(new Map(items.map(x => [x.id, x])).values());
  cacheSet(key, unique, 'episodes');
  return unique;
}

export async function getHiAnimeEpisodes(animeId: string): Promise<HiAnimeEpisode[]> {
  const key = 'hianime:eps:v2:' + animeId;
  const cached = cacheGet<HiAnimeEpisode[]>(key);
  if (cached) return cached;

  const watchUrl = '/watch/' + encodeURIComponent(animeId);
  const { data } = await client.get(watchUrl);
  const $ = cheerio.load(data);

  // HiAnime's current episode-list AJAX endpoint requires its internal numeric anime ID.
  // Current HiAnime pages expose the numeric anime ID on #ani_detail.
  // Its data-id is the *current episode ID*, so do not use that for the list endpoint.
  let internalAnimeId = String(
    $('#ani_detail').attr('data-anime-id')
      || $('.anis-content[data-anime-id]').attr('data-anime-id')
      || ''
  );

  // Older page variants may expose the ID in syncData or #watch-main.
  if (!internalAnimeId) {
    const syncData = $('#syncData').text().trim();
    if (syncData) {
      try {
        const parsed = JSON.parse(syncData);
        internalAnimeId = String(parsed?.anime_id || parsed?.animeId || '');
      } catch { /* continue to legacy attributes */ }
    }
  }
  internalAnimeId ||= String($('#watch-main').attr('data-id') || '');

  let episodeRoot = $('#w-episodes');
  if (internalAnimeId) {
    try {
      const response = await client.get('/ajax/v2/episode/list/' + encodeURIComponent(internalAnimeId), {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Referer: absolute(watchUrl),
        },
      });
      const html = response.data?.html || response.data?.result || '';
      if (html) {
        const episodeHtml = cheerio.load(html);
        episodeRoot = episodeHtml('#episodes-page, #w-episodes, .detail-infor-content, body').first();
        if (!episodeRoot.length) episodeRoot = episodeHtml.root();
      }
    } catch {
      // Keep any server-rendered episode markup as a fallback.
    }
  }

  const episodes: HiAnimeEpisode[] = [];
  episodeRoot.find('a.ssl-item, a[href*="?ep="], a[data-id], a[data-num]').each((index, el) => {
    const a = $(el);
    const href = a.attr('href') || '';
    const absoluteHref = absolute(href || watchUrl);
    const parsedUrl = new URL(absoluteHref);
    const epId = parsedUrl.searchParams.get('ep') || a.attr('data-id') || a.attr('data-ids') || '';
    const episodePath = parsedUrl.pathname.replace(/^\\//, '');
    const rawNum = a.attr('data-number') || a.attr('data-num') || a.attr('data-episode') || '';
    const text = [rawNum, a.attr('title'), a.text()].filter(Boolean).join(' ');
    const match = text.match(/(?:episode|ep)[\\s._-]*(\\d+(?:\\.\\d+)?)/i)
      || text.match(/^\\s*(\\d+(?:\\.\\d+)?)\\s*$/);
    const num = match ? Number.parseFloat(match[1]) : index + 1;
    if (!epId) return;

    const title = a.attr('title') || a.find('.ep-name').attr('title') || ('Episode ' + num);
    const id = [animeId, epId, encodeURIComponent(episodePath)].join('::');
    episodes.push({ id, num, title });
  });

  const unique = Array.from(new Map(episodes.map(ep => [ep.id, ep])).values())
    .sort((a, b) => a.num - b.num);
  if (unique.length) cacheSet(key, unique, 'episodes');
  return unique;
}

export async function getHiAnimeServers(episodeId: string): Promise<HiAnimeServer[]> {
  const key = 'hianime:servers:' + episodeId;
  const cached = cacheGet<HiAnimeServer[]>(key);
  if (cached) return cached;
  const [animeId, dataIds, encodedPath] = episodeId.split('::');
  let ids = dataIds;
  if (!ids) {
    if (!animeId || !encodedPath) return [];
    const { data } = await client.get('/watch/' + encodeURIComponent(animeId));
    const $ = cheerio.load(data);
    const targetPath = decodeURIComponent(encodedPath);
    ids = $('#w-episodes a').filter((_, el) => pathname($(el).attr('href') || '') === targetPath)
      .first().attr('data-ids') || '';
  }
  if (!ids) return [];
  const { data } = await client.get('/ajax/server/list', {
    params: { servers: ids },
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  const $ = cheerio.load(data?.result || '');
  const servers: HiAnimeServer[] = [];
  $('.server, li').each((_, el) => {
    const item = $(el);
    const linkId = item.attr('data-link-id');
    if (!linkId) return;
    const label = item.closest('.type').find('label, .name').text().toLowerCase();
    servers.push({
      name: item.text().trim() || 'HiAnime server',
      sourceId: [linkId, item.attr('data-sv-id') || ''].join('::'),
      type: label.includes('dub') ? 'dub' : label.includes('raw') ? 'raw' : 'sub',
    });
  });
  cacheSet(key, servers, 'episodes');
  return servers;
}

/** Return the provider embed URL without attempting to bypass protected playback controls. */
export async function getHiAnimeStream(sourceId: string): Promise<{ embedUrl: string; playbackMode: 'iframe'; serverName: string } | null> {
  const [linkId, svId] = sourceId.split('::');
  if (!linkId) return null;
  const { data } = await client.get('/ajax/server', {
    params: { get: linkId, ...(svId ? { sv: svId } : {}) },
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  const raw = data?.result?.url;
  if (typeof raw !== 'string') return null;
  const embedUrl = new URL(raw, BASE);
  if (!['http:', 'https:'].includes(embedUrl.protocol)) return null;
  return { embedUrl: embedUrl.toString(), playbackMode: 'iframe', serverName: 'HiAnime' };
}
