import axios from 'axios';
import * as cheerio from 'cheerio';
import { cacheGet, cacheSet } from '../utils/cache';
import { resolveEmbed } from '../resolvers/megacloud';

const BASE = 'https://hianime.at';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: BASE + '/', Accept: 'text/html,application/json,*/*' };
const XOR_KEY = Buffer.from('otaku-embed-v1');

export interface HiAnimeEpisode {
  id: string;
  num: number;
  title: string;
}

export interface HiAnimeServer {
  name: string;
  sourceId: string;
  type: 'sub' | 'dub' | 'raw';
}

export interface HiAnimeStream {
  embedUrl: string;
  m3u8: string;
  referer: string;
  subtitles: { url: string; lang: string; default: boolean }[];
}

function decodeXorPayload(value: string): any {
  const input = Buffer.from(value, 'base64');
  if (!input.length) throw new Error('Empty HiAnime player payload');
  const output = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) output[i] = input[i] ^ XOR_KEY[i % XOR_KEY.length];
  return JSON.parse(output.toString('utf8'));
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export async function searchHiAnime(query: string): Promise<{ id: string; title: string }[]> {
  const key = `hianime:search:${query.toLowerCase().trim()}`;
  const cached = cacheGet<{ id: string; title: string }[]>(key);
  if (cached) return cached;

  const { data } = await axios.get(`${BASE}/search`, {
    params: { keyword: query },
    headers: HEADERS,
    timeout: 12000,
  });
  const $ = cheerio.load(String(data ?? ''));
  const results: { id: string; title: string }[] = [];
  $('a[href*="/watch/"]').each((_, element) => {
    const href = $(element).attr('href') ?? '';
    const title = ($(element).attr('title') || $(element).find('h3').text() || $(element).text()).replace(/\s+/g, ' ').trim();
    const id = href.match(/\/watch\/([^/?#]+)/i)?.[1];
    if (id && title && !results.some((item) => item.id === id)) results.push({ id, title });
  });
  cacheSet(key, results, 'episodes');
  return results;
}

function titleScore(query: string, candidate: string): number {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = normalize(query);
  const b = normalize(candidate);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return Math.round(Math.min(a.length, b.length) / Math.max(a.length, b.length) * 85);
  const words = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const candidateWords = new Set(candidate.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const overlap = [...words].filter((word) => candidateWords.has(word)).length;
  return Math.round(overlap / Math.max(words.size, 1) * 70);
}

export async function findHiAnimeId(title: string): Promise<string | null> {
  const variants = [...new Set([title, title.split(/[:(|-]/)[0]?.trim(), title.split(/\s+/).slice(0, 3).join(' ')].filter(Boolean))];
  const all: { id: string; title: string }[] = [];
  for (const variant of variants) {
    const found = await searchHiAnime(variant).catch(() => []);
    all.push(...found);
    if (found.some((item) => titleScore(title, item.title) >= 85)) break;
  }
  const unique = [...new Map(all.map((item) => [item.id, item])).values()];
  const best = unique.map((item) => ({ ...item, score: titleScore(title, item.title) })).sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 65 ? best.id : null;
}

export async function getHiAnimeEpisodes(animeId: string): Promise<HiAnimeEpisode[]> {
  const key = `hianime:episodes:${animeId}`;
  const cached = cacheGet<HiAnimeEpisode[]>(key);
  if (cached) return cached;

  const { data } = await axios.get(`${BASE}/api/theme/episode/list/${encodeURIComponent(animeId)}`, {
    headers: { ...HEADERS, Referer: `${BASE}/watch/${animeId}` },
    timeout: 12000,
  });
  const html = typeof data === 'string' ? data : String(data?.html ?? data?.result ?? '');
  const $ = cheerio.load(html);
  const episodes: HiAnimeEpisode[] = [];

  $('[data-id], a[href*="ep-"], a[href*="episode"]').each((_, element) => {
    const node = $(element);
    const id = node.attr('data-id') || node.attr('data-episode-id') || node.attr('href')?.match(/(?:ep-|episode-)(\d+)/i)?.[1];
    const rawNumber = node.attr('data-number') || node.attr('data-episode-number') || node.find('[data-number]').attr('data-number') || node.text().match(/(?:episode\s*)?(\d+(?:\.\d+)?)/i)?.[1];
    const num = Number(rawNumber);
    if (!id || !Number.isFinite(num) || num <= 0) return;
    episodes.push({ id, num, title: node.attr('title') || node.text().replace(/\s+/g, ' ').trim() || `Episode ${num}` });
  });

  const unique = [...new Map(episodes.map((episode) => [episode.id, episode])).values()].sort((a, b) => a.num - b.num);
  cacheSet(key, unique, 'episodes');
  return unique;
}

export async function getHiAnimeServers(episodeId: string): Promise<HiAnimeServer[]> {
  const key = `hianime:servers:${episodeId}`;
  const cached = cacheGet<HiAnimeServer[]>(key);
  if (cached) return cached;

  const { data } = await axios.get(`${BASE}/api/theme/episode/servers`, {
    params: { episodeId },
    headers: { ...HEADERS, Referer: `${BASE}/` },
    timeout: 12000,
  });
  const html = typeof data === 'string' ? data : String(data?.html ?? data?.result ?? '');
  const $ = cheerio.load(html);
  const servers: HiAnimeServer[] = [];

  $('[data-hash]').each((_, element) => {
    const node = $(element);
    const hash = node.attr('data-hash');
    if (!hash) return;
    const rawType = (node.attr('data-type') || node.closest('[data-type]').attr('data-type') || '').toLowerCase();
    const type: HiAnimeServer['type'] = rawType === 'dub' ? 'dub' : rawType === 'raw' ? 'raw' : 'sub';
    const name = node.attr('data-server-name') || node.attr('data-server') || node.text().replace(/\s+/g, ' ').trim() || 'Unknown';
    const sourceId = Buffer.from(JSON.stringify({ episodeId, hash, type, name })).toString('base64url');
    if (!servers.some((server) => server.sourceId === sourceId)) servers.push({ name, sourceId, type });
  });

  cacheSet(key, servers, 'episodes');
  return servers;
}

export async function getHiAnimeStream(sourceId: string): Promise<HiAnimeStream | null> {
  try {
    const decoded = JSON.parse(Buffer.from(sourceId, 'base64url').toString('utf8'));
    const hash = String(decoded?.hash ?? '');
    if (!hash) return null;

    const embedUrl = safeHttpUrl(Buffer.from(hash, 'base64').toString('utf8'));
    if (!embedUrl) return null;
    const embedOrigin = new URL(embedUrl).origin;
    const referer = embedOrigin + '/';
    const { data: htmlData } = await axios.get(embedUrl, {
      headers: { ...HEADERS, Referer: `${BASE}/` },
      timeout: 12000,
    });
    const html = String(htmlData ?? '');
    const payloadMatch = html.match(/window\.__P\s*=\s*["']([^"']+)["']/);
    let payload: any = null;
    if (payloadMatch?.[1]) {
      try { payload = decodeXorPayload(payloadMatch[1]); } catch { payload = null; }
    }

    let m3u8 = safeHttpUrl(payload?.src ?? payload?.sources?.[0]?.file ?? payload?.file);
    const payloadTracks = Array.isArray(payload?.tracks) ? payload.tracks : Array.isArray(payload?.tracks?.captions) ? payload.tracks.captions : [];
    let subtitles = payloadTracks
      .filter((track: any) => track?.file && /^https?:\/\//i.test(track.file))
      .map((track: any) => ({ url: track.file, lang: track.label ?? 'Unknown', default: Boolean(track.default) }));

    // Some HiAnime servers resolve through an established Megacloud/Vidstream extractor.
    if (!m3u8) {
      const resolved = await resolveEmbed(embedUrl).catch(() => null);
      if (resolved?.m3u8) {
        m3u8 = safeHttpUrl(resolved.m3u8);
        subtitles = (resolved.subtitles ?? []).map((track: any) => ({ url: track.url, lang: track.lang ?? 'Unknown', default: Boolean(track.default) }));
      }
    }
    if (!m3u8) return null;
    return { embedUrl, m3u8, referer, subtitles };
  } catch {
    return null;
  }
}
