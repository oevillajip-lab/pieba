// Puerta de entrada de la app PIEBA Mail: la app solo conoce este dominio.
// Reenvía a las funciones de Supabase agregando la clave del proyecto, así el
// APK no contiene ninguna clave, URL de Supabase ni identificador de Zoho.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ywftajhexpnofsoupfht.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_toCu6NDhiY3cGz5eBbHTvA_5qUgpH2J';
const FUNCIONES = { token: 'zoho-token', push: 'mail-push', buzon: 'buzon' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { servicio, ...resto } = body;
  const funcion = FUNCIONES[servicio];
  if (!funcion) return res.status(400).json({ error: 'servicio_desconocido' });
  // La revisión del cron se llama directo en Supabase, nunca desde acá
  if (servicio === 'push' && resto.accion === 'revisar') return res.status(403).json({ error: 'no_permitido' });
  // La entrega de correos entrantes la hace Cloudflare directo en Supabase
  if (servicio === 'buzon' && String(resto.accion || '').startsWith('entrante')) {
    return res.status(403).json({ error: 'no_permitido' });
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${funcion}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify(resto),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(await r.text());
  } catch {
    return res.status(502).json({ error: 'servidor_no_disponible' });
  }
}
