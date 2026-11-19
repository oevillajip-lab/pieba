// ════════════════════════════════════════════════════════════════
//  PIEBA Mail · Intercambio de tokens OAuth con Zoho
// ════════════════════════════════════════════════════════════════
//  La app (APK) no guarda el client secret de Zoho: le pide a esta
//  función que haga el intercambio. El secreto vive solo acá, como
//  variable de entorno de Supabase.
//
//  Variables (Supabase → Edge Functions → Secrets):
//    ZOHO_CLIENT_ID      → Client ID de la app en api-console.zoho.com
//    ZOHO_CLIENT_SECRET  → Client Secret de esa app
//
//  Al desplegar: desactivar "Verify JWT" (la app no tiene sesión de
//  Supabase). La función valida todo por su cuenta.
//
//  Peticiones (POST, JSON):
//    { "grant_type": "authorization_code", "code": "...", "code_verifier": "...", "redirect_uri": "piebamail://callback" }
//    { "grant_type": "refresh_token", "refresh_token": "..." }
// ════════════════════════════════════════════════════════════════

const ZOHO_ACCOUNTS = 'https://accounts.zoho.com';
const ZOHO_MAIL = 'https://mail.zoho.com';
const DOMINIO_PERMITIDO = 'primeradeasuncion.org.py';
const REDIRECT_PERMITIDO = 'piebamail://callback';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function pedirTokenAZoho(params: Record<string, string>) {
  const res = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && !!body.access_token, body };
}

// Devuelve todos los correos de la cuenta de Zoho Mail del token
async function correosDeLaCuenta(accessToken: string): Promise<string[]> {
  const res = await fetch(`${ZOHO_MAIL}/api/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  const correos: string[] = [];
  for (const cuenta of body?.data ?? []) {
    const e = cuenta?.emailAddress;
    if (typeof e === 'string') correos.push(e);
    else if (Array.isArray(e)) for (const x of e) correos.push(typeof x === 'string' ? x : x?.mailId ?? '');
    if (cuenta?.mailId) correos.push(cuenta.mailId);
    if (cuenta?.primaryEmailAddress) correos.push(cuenta.primaryEmailAddress);
  }
  return correos.filter(Boolean).map((c) => c.toLowerCase());
}

async function revocar(token: string) {
  await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const clientId = Deno.env.get('ZOHO_CLIENT_ID');
  const clientSecret = Deno.env.get('ZOHO_CLIENT_SECRET');
  if (!clientId || !clientSecret) return json(500, { error: 'server_misconfigured' });

  let p: Record<string, string>;
  try { p = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  if (p.grant_type === 'authorization_code') {
    if (!p.code || !p.code_verifier) return json(400, { error: 'missing_params' });
    if (p.redirect_uri !== REDIRECT_PERMITIDO) return json(400, { error: 'invalid_redirect_uri' });

    const { ok, body } = await pedirTokenAZoho({
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.code_verifier,
      redirect_uri: REDIRECT_PERMITIDO,
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (!ok) return json(400, { error: body.error ?? 'zoho_error', error_description: body.error_description });

    // Solo cuentas de la iglesia
    const correos = await correosDeLaCuenta(body.access_token);
    if (!correos.some((c) => c.endsWith(`@${DOMINIO_PERMITIDO}`))) {
      if (body.refresh_token) await revocar(body.refresh_token);
      return json(403, {
        error: 'dominio_no_permitido',
        error_description: `Solo se puede ingresar con una cuenta @${DOMINIO_PERMITIDO}.`,
      });
    }
    return json(200, body);
  }

  if (p.grant_type === 'refresh_token') {
    if (!p.refresh_token) return json(400, { error: 'missing_params' });
    const { ok, body } = await pedirTokenAZoho({
      grant_type: 'refresh_token',
      refresh_token: p.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (!ok) return json(400, { error: body.error ?? 'zoho_error', error_description: body.error_description });
    return json(200, body);
  }

  return json(400, { error: 'unsupported_grant_type' });
});
