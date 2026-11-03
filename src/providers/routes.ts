import { Router, Request, Response } from 'express';
import { searchHiAnime, getHiAnimeEpisodes, getHiAnimeServers, getHiAnimeStream } from './hianime';
import { searchAnimePahe, getAnimePaheEpisodes, getAnimePaheServers, getAnimePaheStream } from './animepahe';
import { getZokoAnimeServers, getZokoAnimeStream } from './zokoanime';

const router = Router();

function safeError(error: any) {
  return error?.response?.status ? `Upstream returned HTTP ${error.response.status}` : 'Provider request failed';
}

router.get('/hianime/search', async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try { const results = await searchHiAnime(q); return res.json({ source: 'hianime', query: q, count: results.length, results }); }
  catch (e) { return res.status(502).json({ source: 'hianime', error: safeError(e) }); }
});

router.get('/hianime/anime/:id/episodes', async (req: Request, res: Response) => {
  try { const episodes = await getHiAnimeEpisodes(req.params.id); return res.json({ source: 'hianime', animeId: req.params.id, count: episodes.length, episodes }); }
  catch (e) { return res.status(502).json({ source: 'hianime', error: safeError(e) }); }
});

router.get('/hianime/episodes/:episodeId/servers', async (req: Request, res: Response) => {
  try { const servers = await getHiAnimeServers(req.params.episodeId); return res.json({ source: 'hianime', count: servers.length, servers }); }
  catch (e) { return res.status(502).json({ source: 'hianime', error: safeError(e) }); }
});

router.get('/hianime/watch', async (req: Request, res: Response) => {
  const sourceId = String(req.query.serverId || '');
  if (!sourceId) return res.status(400).json({ error: 'Missing ?serverId=' });
  try { const stream = await getHiAnimeStream(sourceId); if (!stream) return res.status(404).json({ error: 'HiAnime server did not return an embed' }); return res.json({ source: 'hianime', ...stream, m3u8: null, subtitles: [], iframeOnly: true }); }
  catch (e) { return res.status(502).json({ source: 'hianime', error: safeError(e) }); }
});

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

router.get('/animepahe/search', async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try { const results = await searchAnimePahe(q); return res.json({ source: 'animepahe', query: q, count: results.length, results }); }
  catch (e) { return res.status(502).json({ source: 'animepahe', error: safeError(e) }); }
});

router.get('/animepahe/anime/:id/episodes', async (req: Request, res: Response) => {
  try { const episodes = await getAnimePaheEpisodes(req.params.id); return res.json({ source: 'animepahe', animeId: req.params.id, count: episodes.length, episodes }); }
  catch (e) { return res.status(502).json({ source: 'animepahe', error: safeError(e) }); }
});

router.get('/animepahe/anime/:id/episodes/:session/servers', async (req: Request, res: Response) => {
  try { const servers = await getAnimePaheServers(req.params.id, req.params.session); return res.json({ source: 'animepahe', count: servers.length, servers }); }
  catch (e) { return res.status(502).json({ source: 'animepahe', error: safeError(e) }); }
});

router.get('/animepahe/watch', async (req: Request, res: Response) => {
  const sourceId = String(req.query.serverId || '');
  if (!sourceId) return res.status(400).json({ error: 'Missing ?serverId=' });
  try { const stream = await getAnimePaheStream(sourceId); if (!stream) return res.status(400).json({ error: 'Invalid AnimePahe server URL' }); return res.json({ source: 'animepahe', ...stream, m3u8: null, subtitles: [], iframeOnly: true }); }
  catch (e) { return res.status(502).json({ source: 'animepahe', error: safeError(e) }); }
});

export default router;
