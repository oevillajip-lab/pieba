// Inicio de sesión de PIEBA Mail con Zoho: la app abre esta dirección y acá se
// arma el enlace de autorización con el Client ID (variable ZOHO_CLIENT_ID en
// Vercel). Así el APK no contiene el Client ID ni los permisos pedidos.
const REDIRECT_URI = 'piebamail://callback';
const SCOPES = [
  'ZohoMail.messages.READ', 'ZohoMail.messages.CREATE', 'ZohoMail.messages.UPDATE', 'ZohoMail.messages.DELETE',
  'ZohoMail.accounts.READ', 'ZohoMail.folders.READ', 'ZohoMail.folders.UPDATE',
  'ZohoContacts.contactapi.READ', 'ZohoContacts.contactapi.CREATE', 'ZohoContacts.contactapi.UPDATE', 'ZohoContacts.contactapi.DELETE',
  'AaaServer.profile.Read',
].join(',');

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Método no permitido');
  const clientId = process.env.ZOHO_CLIENT_ID;
  if (!clientId) return res.status(500).send('Servidor sin configurar');
  const challenge = String(req.query.code_challenge || '');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return res.status(400).send('code_challenge inválido');

  const url = new URL('https://accounts.zoho.com/oauth/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', url.toString());
  return res.status(302).end();
}
