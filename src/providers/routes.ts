import { Router, Request, Response } from 'express';
import { getZokoAnimeServers, getZokoAnimeStream } from './zokoanime';

const router = Router();

function safeError(error: any) {
  return error?.response?.status ? `Upstream returned HTTP ${error.response.status}` : 'Provider request failed';
}

router.get('/zokoanime/servers', async (req: Request, res: Response) => {
  const malId = String(req.query.malId || '');
  const episode = Number(req.query.ep);
  if (!malId || !Number.isSafeInteger(episode) || episode < 1) {
    return res.status(400).json({ error: 'Required query params: ?malId={malId}&ep={episodeNumber}' });
  }
  const servers = getZokoAnimeServers(malId, episode);
  if (!servers.length) return res.status(400).json({ error: 'Invalid MAL ID or episode number' });
  return res.json({ source: 'zokoanime', malId, episode, count: servers.length, servers });
});

router.get('/zokoanime/watch', async (req: Request, res: Response) => {
  const sourceId = String(req.query.serverId || '');
  if (!sourceId) return res.status(400).json({ error: 'Missing ?serverId=' });
  const stream = getZokoAnimeStream(sourceId);
  if (!stream) return res.status(400).json({ error: 'Invalid ZokoAnime server ID' });
  return res.json({ source: 'zokoanime', ...stream, m3u8: null, subtitles: [], iframeOnly: true });
});

export default router;
