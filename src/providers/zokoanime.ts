export interface ZokoAnimeServer {
  name: string;
  sourceId: string;
  type: 'sub' | 'dub';
}

/**
 * ZokoAnime exposes a direct MAL-ID/episode URL pattern from the HiAnime
 * server hash: /stream/mal/:malId/:episode/:type.
 *
 * This adapter only constructs the observed embed URL. It does not scrape
 * ZokoAnime search/catalogue data or claim that every generated URL is live.
 */
export function getZokoAnimeServers(malId: string, episode: number): ZokoAnimeServer[] {
  if (!/^\d+$/.test(malId) || !Number.isSafeInteger(episode) || episode < 1) return [];

  return (['sub', 'dub'] as const).map(type => ({
    name: 'ZokoAnime',
    sourceId: [malId, String(episode), type].join('::'),
    type,
  }));
}

export function getZokoAnimeStream(sourceId: string): {
  embedUrl: string;
  playbackMode: 'iframe';
  serverName: 'ZokoAnime';
} | null {
  const [malId, episodeText, type, ...extra] = sourceId.split('::');
  const episode = Number(episodeText);

  if (
    extra.length ||
    !/^\d+$/.test(malId || '') ||
    !Number.isSafeInteger(episode) ||
    episode < 1 ||
    (type !== 'sub' && type !== 'dub')
  ) return null;

  return {
    embedUrl: `https://zokoanime.video/stream/mal/${malId}/${episode}/${type}`,
    playbackMode: 'iframe',
    serverName: 'ZokoAnime',
  };
}
