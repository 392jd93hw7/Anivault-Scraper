import axios from 'axios';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://zokoanime.video';
const REFERER = BASE + '/';
const OBFS_KEY = 'otaku-embed-v1';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

export interface ZokoAnimeEpisode {
  num: number;
  id: string;
  title: string;
}

export interface ZokoAnimeSubtitle {
  lang: string;
  url: string;
  default?: boolean;
}

export interface ZokoAnimeStream {
  embedUrl: string;
  m3u8: string | null;
  referer: string;
  subtitles: ZokoAnimeSubtitle[];
}

const client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: REFERER,
    Origin: BASE,
  },
});

function decodeBase64(input: string): number[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const value = input.replace(/\s/g, '');
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Invalid Base64 payload');
  }

  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = alphabet.indexOf(value[index]);
    const b = alphabet.indexOf(value[index + 1]);
    const c = value[index + 2] === '=' ? 0 : alphabet.indexOf(value[index + 2]);
    const d = value[index + 3] === '=' ? 0 : alphabet.indexOf(value[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('Invalid Base64 character');
    bytes.push((a << 2) | (b >> 4));
    if (value[index + 2] !== '=') bytes.push(((b & 15) << 4) | (c >> 2));
    if (value[index + 3] !== '=') bytes.push(((c & 3) << 6) | d);
  }
  return bytes;
}

function deobfuscate(blob: string): any {
  const encoded = decodeBase64(blob);
  const bytes = encoded.map((byte, index) => byte ^ OBFS_KEY.charCodeAt(index % OBFS_KEY.length));
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

async function anilistRequest(query: string, variables: Record<string, number>): Promise<any> {
  const { data } = await client.post('https://graphql.anilist.co', { query, variables }, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Referer: REFERER },
    timeout: 10000,
  });
  if (data?.errors?.length) throw new Error(data.errors[0]?.message || 'AniList request failed');
  return data;
}

export async function getZokoAnimeEpisodes(malId: number): Promise<ZokoAnimeEpisode[]> {
  if (!Number.isInteger(malId) || malId <= 0) return [];
  const key = `zokoanime:episodes:${malId}`;
  const cached = cacheGet<ZokoAnimeEpisode[]>(key);
  if (cached) return cached;

  const query = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        episodes
        nextAiringEpisode { episode }
      }
    }
  `;
  const data = await anilistRequest(query, { idMal: malId });
  const media = data?.data?.Media;
  if (!media) return [];

  const known = Number(media.episodes);
  const next = Number(media.nextAiringEpisode?.episode);
  const count = Number.isInteger(known) && known > 0
    ? known
    : Number.isInteger(next) && next > 1 ? next - 1 : 0;
  if (!count) return [];

  const episodes = Array.from({ length: count }, (_, index) => {
    const num = index + 1;
    return { num, id: String(num), title: `Episode ${num}` };
  });
  cacheSet(key, episodes, 'episodes');
  return episodes;
}

export async function getZokoAnimeStream(
  malId: number,
  episode: number,
  track: 'sub' | 'dub'
): Promise<ZokoAnimeStream | null> {
  if (!Number.isInteger(malId) || malId <= 0 || !Number.isInteger(episode) || episode < 1) return null;

  const cacheKey = `zokoanime:stream:${malId}:${episode}:${track}`;
  const cached = cacheGet<ZokoAnimeStream>(cacheKey);
  if (cached) return cached;

  const embedUrl = `${BASE}/stream/mal/${malId}/${episode}/${track}`;
  try {
    const response = await client.get<string>(embedUrl, {
      responseType: 'text',
      headers: { Referer: REFERER },
      maxRedirects: 5,
    });
    const html = typeof response.data === 'string' ? response.data : '';
    const payload = html.match(/window\.__P\s*=\s*["']([^"']+)["']/)?.[1];
    if (!payload) throw new Error('ZokoAnime player payload not found');

    const decoded = deobfuscate(payload);
    const streamUrl = typeof decoded?.src === 'string' ? decoded.src : null;
    const subtitles: ZokoAnimeSubtitle[] = (Array.isArray(decoded?.subtitles) ? decoded.subtitles : [])
      .filter((item: any) => item && typeof item.src === 'string' && /^https?:\/\//i.test(item.src))
      .map((item: any) => ({
        url: item.src,
        lang: String(item.label || item.lang || 'Unknown'),
        default: Boolean(item.default),
      }));

    // A missing direct source is still a usable hosted-player response.
    const result: ZokoAnimeStream = {
      embedUrl,
      m3u8: streamUrl && /^https?:\/\//i.test(streamUrl) ? streamUrl : null,
      referer: REFERER,
      subtitles,
    };
    cacheSet(cacheKey, result, 'stream');
    return result;
  } catch (error: any) {
    console.error('[zokoanime] stream resolution failed', {
      malId,
      episode,
      track,
      status: error?.response?.status,
      message: error?.message || String(error),
    });
    return null;
  }
}
