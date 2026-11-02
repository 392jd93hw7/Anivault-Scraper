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
  const key = 'hianime:eps:' + animeId;
  const cached = cacheGet<HiAnimeEpisode[]>(key);
  if (cached) return cached;
  const { data } = await client.get('/watch/' + encodeURIComponent(animeId));
  const $ = cheerio.load(data);
  const watchId = $('#watch-main').attr('data-id') || '';
  if (watchId && $('#w-episodes a').length === 0) {
    try {
      const response = await client.get('/ajax/episode/list/' + encodeURIComponent(watchId), {
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: BASE + '/watch/' + animeId },
      });
      const html = response.data?.result || '';
      if (html) $('#w-episodes').html(cheerio.load(html).root().html() || '');
    } catch { /* use server-rendered episodes */ }
  }
  const episodes: HiAnimeEpisode[] = [];
  $('#w-episodes a[href], #w-episodes a[data-num]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href') || '';
    const numText = a.attr('data-num') || a.find('.number, .d-title, span').first().text().trim() || pathname(href).match(/ep-(\d+(?:\.\d+)?)/)?.[1] || '';
    const num = Number.parseFloat(numText);
    const dataIds = a.attr('data-ids') || a.attr('data-id') || '';
    const episodePath = pathname(href);
    const id = [animeId, dataIds, encodeURIComponent(episodePath)].join('::');
    if (dataIds || episodePath) {
      episodes.push({ id, num, title: a.attr('title') || 'Episode ' + numText });
    }
  });
  const unique = Array.from(new Map(episodes.map(ep => [ep.id, ep])).values()).sort((a,b) => a.num-b.num);
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
