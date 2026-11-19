// Proxy de la API de YouTube: la clave vive solo en Vercel (variable YT_API_KEY),
// nunca en el navegador ni en el repositorio.
const CANAL = 'UCcijrVl3zWSXSuzP3nQI32A';
const PERMITIDOS = {
  channels: ['part', 'id'],
  playlistItems: ['part', 'playlistId', 'maxResults', 'pageToken'],
  videos: ['part', 'id'],
  search: ['part', 'channelId', 'eventType', 'type', 'order', 'maxResults'],
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const key = process.env.YT_API_KEY;
  if (!key) return res.status(500).json({ error: 'server_misconfigured' });

  const endpoint = String(req.query.endpoint || '');
  const campos = PERMITIDOS[endpoint];
  if (!campos) return res.status(400).json({ error: 'endpoint_no_permitido' });

  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const c of campos) if (req.query[c]) url.searchParams.set(c, String(req.query[c]));
  // Solo se permite consultar el canal de la iglesia
  if (endpoint === 'search') url.searchParams.set('channelId', CANAL);
  if (endpoint === 'channels') url.searchParams.set('id', CANAL);
  url.searchParams.set('key', key);

  try {
    const r = await fetch(url);
    const body = await r.text();
    // Cache en el borde de Vercel: ahorra cuota de YouTube
    res.setHeader('Cache-Control', endpoint === 'search' ? 's-maxage=60, stale-while-revalidate=60' : 's-maxage=600, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(body);
  } catch {
    return res.status(502).json({ error: 'youtube_no_disponible' });
  }
}
