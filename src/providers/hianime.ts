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
  const key = 'hianime:eps:v3:' + animeId;
  const cached = cacheGet<HiAnimeEpisode[]>(key);
  if (cached) return cached;

  const watchUrl = '/watch/' + encodeURIComponent(animeId);
  const { data: pageHtml } = await client.get(watchUrl);
  const $page = cheerio.load(pageHtml);

  // #ani_detail exposes the numeric anime ID. data-id is the current episode ID.
  let internalAnimeId = String(
    $page('#ani_detail').attr('data-anime-id')
      || $page('.anis-content[data-anime-id]').attr('data-anime-id')
      || ''
  );

  if (!internalAnimeId) {
    const syncData = $page('#syncData').text().trim();
    if (syncData) {
      try {
        const parsed = JSON.parse(syncData);
        internalAnimeId = String(parsed?.anime_id || parsed?.animeId || '');
      } catch { /* continue to legacy attributes */ }
    }
  }
  internalAnimeId ||= String($page('#watch-main').attr('data-id') || '');

  let episodeHtml = '';
  if (internalAnimeId) {
    const response = await client.get('/api/theme/episode/list/' + encodeURIComponent(internalAnimeId), {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: absolute(watchUrl),
        Accept: 'application/json',
      },
    });
    if (response.data?.status && typeof response.data?.html === 'string') {
      episodeHtml = response.data.html;
    }
  }

  const $episodes = cheerio.load(episodeHtml || $page.html() || '');
  const episodes: HiAnimeEpisode[] = [];

  $episodes('a.ep-item, a.ssl-item, a[href*="?ep="]').each((index, el) => {
    const a = $episodes(el);
    const href = a.attr('href') || '';
    const parsedUrl = new URL(absolute(href || watchUrl));
    const epId = parsedUrl.searchParams.get('ep') || a.attr('data-id') || '';
    const rawNum = a.attr('data-number') || a.attr('data-num') || a.attr('data-episode') || '';
    const text = [rawNum, a.attr('title'), a.find('.ep-name').text(), a.text()].filter(Boolean).join(' ');
    const match = text.match(/(?:episode|ep)[\s._-]*(\d+(?:\.\d+)?)/i)
      || text.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
    const num = match ? Number.parseFloat(match[1]) : index + 1;
    if (!epId || !Number.isFinite(num)) return;

    const title = a.attr('title') || a.find('.ep-name').attr('title') || a.find('.ep-name').text().trim() || ('Episode ' + num);
    const episodePath = parsedUrl.pathname.replace(/^\/+/, '');
    const id = [animeId, epId, encodeURIComponent(episodePath)].join('::');
    episodes.push({ id, num, title });
  });

  const unique = Array.from(new Map(episodes.map(ep => [ep.id, ep])).values())
    .sort((a, b) => a.num - b.num);
  if (unique.length) cacheSet(key, unique, 'episodes');
  return unique;
}

export async function getHiAnimeServers(episodeId: string): Promise<HiAnimeServer[]> {
  const key = 'hianime:servers:v2:' + episodeId;
  const cached = cacheGet<HiAnimeServer[]>(key);
  if (cached) return cached;

  // Episode IDs are encoded as animeSlug::episodeId::watchPath.
  const [, upstreamEpisodeId] = episodeId.split('::');
  if (!upstreamEpisodeId) return [];

  const watchUrl = '/watch/' + encodeURIComponent(episodeId.split('::')[0]) + '?ep=' + encodeURIComponent(upstreamEpisodeId);
  const { data } = await client.get('/api/theme/episode/servers', {
    params: { episodeId: upstreamEpisodeId },
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: absolute(watchUrl),
      Accept: 'application/json',
    },
  });

  if (!data?.status || typeof data?.html !== 'string') return [];

  const $ = cheerio.load(data.html);
  const servers: HiAnimeServer[] = [];
  $('.server-item[data-hash]').each((_, el) => {
    const item = $(el);
    const hash = String(item.attr('data-hash') || '').trim();
    if (!hash) return;

    const rawType = String(item.attr('data-type') || '').toLowerCase();
    const type: HiAnimeServer['type'] = rawType === 'dub' ? 'dub' : rawType === 'raw' ? 'raw' : 'sub';
    const name = String(item.attr('data-server-name') || item.text()).trim() || 'HiAnime server';
    servers.push({ name, sourceId: hash, type });
  });

  const unique = Array.from(new Map(servers.map(server => [server.sourceId, server])).values());
  cacheSet(key, unique, 'episodes');
  return unique;
}

/** Decode HiAnime's server hash and return the provider's iframe URL. */
export async function getHiAnimeStream(sourceId: string): Promise<{ embedUrl: string; playbackMode: 'iframe'; serverName: string } | null> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sourceId)) return null;

  let raw: string;
  try {
    raw = Buffer.from(sourceId, 'base64').toString('utf8');
  } catch {
    return null;
  }

  let embedUrl: URL;
  try {
    embedUrl = new URL(raw);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(embedUrl.protocol)) return null;
  return {
    embedUrl: embedUrl.toString(),
    playbackMode: 'iframe',
    serverName: 'HiAnime',
  };
}
