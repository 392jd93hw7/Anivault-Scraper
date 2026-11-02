import axios from 'axios';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = (process.env.ANIMEPAHE_BASE_URL || 'https://animepahe.ch').replace(/\/$/, '');
const API = BASE + '/api';
const client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: BASE + '/',
    Accept: 'application/json, text/plain, */*',
  },
});

export interface AnimePaheSearchResult { id: string; session: string; title: string; image: string | null; type: string | null; }
export interface AnimePaheEpisode { id: string; num: number; title: string; session: string; }
export interface AnimePaheServer { name: string; sourceId: string; type: 'sub' | 'dub' | 'raw'; quality: string; }

/** AnimePahe's JSON API exposes anime sessions, paginated releases and Kwik links. */
export async function searchAnimePahe(query: string): Promise<AnimePaheSearchResult[]> {
  const key = 'animepahe:search:' + query.toLowerCase().trim();
  const cached = cacheGet<AnimePaheSearchResult[]>(key);
  if (cached) return cached;
  const { data } = await client.get(API, { params: { m: 'search', l: 8, q: query } });
  const results = (data?.data || []).map((item: any) => ({
    id: String(item.id), session: String(item.session), title: String(item.title || ''),
    image: item.poster || null, type: item.type || null,
  })).filter((item: AnimePaheSearchResult) => item.id && item.session && item.title);
  cacheSet(key, results, 'episodes');
  return results;
}

export async function getAnimePaheEpisodes(animeId: string): Promise<AnimePaheEpisode[]> {
  const key = 'animepahe:eps:' + animeId;
  const cached = cacheGet<AnimePaheEpisode[]>(key);
  if (cached) return cached;
  const episodes: AnimePaheEpisode[] = [];
  let page = 1;
  let lastPage = 1;
  do {
    const { data } = await client.get(API, {
      params: { m: 'release', id: animeId, sort: 'episode_asc', page },
    });
    lastPage = Math.max(1, Number(data?.last_page) || 1);
    for (const item of data?.data || []) {
      const num = Number(item.episode);
      if (!Number.isFinite(num)) continue;
      episodes.push({
        id: String(item.session),
        session: String(item.session),
        num,
        title: item.title || 'Episode ' + num,
      });
    }
    page += 1;
  } while (page <= lastPage && page <= 100);
  const unique = Array.from(new Map(episodes.map(ep => [ep.session, ep])).values()).sort((a,b) => a.num-b.num);
  cacheSet(key, unique, 'episodes');
  return unique;
}

export async function getAnimePaheServers(animeId: string, episodeSession: string): Promise<AnimePaheServer[]> {
  const key = 'animepahe:servers:' + animeId + ':' + episodeSession;
  const cached = cacheGet<AnimePaheServer[]>(key);
  if (cached) return cached;
  const { data } = await client.get(API, {
    params: { m: 'links', id: animeId, session: episodeSession, p: 'kwik' },
  });
  const servers: AnimePaheServer[] = [];
  const variants = data?.data || {};
  for (const group of Array.isArray(variants) ? variants : Object.values(variants)) {
    if (!group || typeof group !== 'object') continue;
    for (const [quality, value] of Object.entries(group as Record<string, any>)) {
      const url = typeof value === 'string' ? value : value?.kwik_adfly || value?.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
      servers.push({
        name: 'Kwik ' + quality,
        sourceId: url,
        type: 'sub',
        quality: String(quality).match(/\d+p/i)?.[0] || String(quality),
      });
    }
  }
  cacheSet(key, servers, 'episodes');
  return servers;
}

/**
 * AnimePahe's links endpoint returns Kwik-hosted embeds/shortlinks. Keep them
 * as embeds; do not try to evade Kwik's access controls or DRM.
 */
export async function getAnimePaheStream(sourceId: string) {
  let url: URL;
  try { url = new URL(sourceId); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return { embedUrl: url.toString(), playbackMode: 'iframe' as const, serverName: 'AnimePahe ' + url.hostname };
}
