import crypto from 'crypto';

// Datos públicos del proyecto Supabase (se pueden sobreescribir con variables de entorno)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ywftajhexpnofsoupfht.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_toCu6NDhiY3cGz5eBbHTvA_5qUgpH2J';

// Verifica que el token sea una sesión válida de Supabase y que el
// correo esté en la lista de usuarios permitidos (función es_admin).
async function esAdmin(token) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` };

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers });
  if (!userRes.ok) return false;

  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/es_admin`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (!rpcRes.ok) return false;
  return (await rpcRes.json()) === true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    if (!(await esAdmin(token))) {
      return res.status(403).json({ error: 'Sesión inválida o sin permiso' });
    }
  } catch (e) {
    return res.status(502).json({ error: 'No se pudo verificar la sesión' });
  }

  // Firmar para Cloudinary
  try {
    const body = req.body || {};
    const pedida = String(body.folder || 'pieba/galeria');
    // Solo se permiten carpetas dentro de "pieba/"
    const folder = /^pieba(\/[\w-]+)*$/.test(pedida) ? pedida : 'pieba/galeria';
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = { folder, source: 'uw', timestamp };
    const sortedParams = Object.keys(paramsToSign)
      .sort()
      .map((key) => `${key}=${paramsToSign[key]}`)
      .join('&');
    const signature = crypto
      .createHash('sha1')
      .update(sortedParams + process.env.CLOUDINARY_API_SECRET)
      .digest('hex');

    return res.status(200).json({
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      folder,
      timestamp,
      signature,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to generate signature' });
  }
}
