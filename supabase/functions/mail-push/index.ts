// ════════════════════════════════════════════════════════════════
//  PIEBA Mail · Avisos de correo nuevo (push) con la app cerrada
// ════════════════════════════════════════════════════════════════
//  Zoho gratis no avisa cuando llega un correo (los webhooks son pagos),
//  así que esta función revisa cada minuto los buzones registrados y,
//  si hay correos nuevos, manda una notificación push por Firebase
//  Cloud Messaging (lo mismo que usa Gmail).
//
//  Acciones (POST JSON):
//    { "accion": "registrar", "fcm_token", "access_token", "refresh_token" }  ← la app al iniciar sesión
//    { "accion": "baja", "fcm_token" }                                       ← la app al cerrar sesión
//    { "accion": "revisar" }  + header x-cron-secret                         ← pg_cron, cada minuto
//
//  Secretos (Supabase → Edge Functions → Secrets):
//    ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET   (los mismos que usa zoho-token)
//    FIREBASE_SERVICE_ACCOUNT             (JSON de la cuenta de servicio de Firebase)
//    MAIL_CIFRADO_KEY                     (32 bytes en base64: cifra los tokens guardados)
//    MAIL_CRON_SECRET                     (texto al azar; el mismo que usa el cron)
//  SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase solo.
//
//  Al desplegar: desactivar "Verify JWT".
// ════════════════════════════════════════════════════════════════

const ZOHO_ACCOUNTS = 'https://accounts.zoho.com';
const DOMINIO_PERMITIDO = 'primeradeasuncion.org.py';
const TABLA = 'mail_dispositivos';
const CANAL_ANDROID = 'pieba_mail_channel';

const env = (k: string) => Deno.env.get(k) ?? '';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ─── Base de datos (REST con la clave de servicio) ──────────────
async function db(method: string, query: string, body?: unknown, prefer?: string) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${TABLA}${query}`, {
    method,
    headers: {
      apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DB ${method} ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// ─── Cifrado de tokens (AES-GCM) ────────────────────────────────
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let claveCache: CryptoKey | null = null;
async function clave() {
  if (claveCache) return claveCache;
  const raw = unb64(env('MAIL_CIFRADO_KEY'));
  if (raw.length !== 32) throw new Error('MAIL_CIFRADO_KEY debe tener 32 bytes en base64');
  claveCache = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return claveCache;
}
async function cifrar(texto: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await clave(), new TextEncoder().encode(texto)));
  return `${b64(iv)}.${b64(enc)}`;
}
async function descifrar(valor: string) {
  const [iv, data] = valor.split('.');
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await clave(), unb64(data));
  return new TextDecoder().decode(dec);
}

// ─── Zoho ───────────────────────────────────────────────────────
async function refrescarToken(refreshToken: string) {
  const res = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env('ZOHO_CLIENT_ID'),
      client_secret: env('ZOHO_CLIENT_SECRET'),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) {
    const err = new Error(`refresh: ${body.error ?? res.status}`) as Error & { revocado?: boolean };
    err.revocado = body.error === 'invalid_code' || body.error === 'invalid_token';
    throw err;
  }
  return { token: body.access_token as string, expira: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
}

async function zohoGet(host: string, path: string, token: string) {
  const res = await fetch(`https://${host}${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (!res.ok) throw new Error(`Zoho ${path} HTTP ${res.status}`);
  return (await res.json())?.data;
}

type Cuenta = { email: string; accountId: string; host: string };
async function cuentaDelToken(token: string): Promise<Cuenta | null> {
  const data = await zohoGet('mail.zoho.com', '/api/accounts', token).catch(() => null);
  const c = Array.isArray(data) ? data[0] : null;
  if (!c) return null;
  let email = '';
  const e = c.emailAddress;
  if (typeof e === 'string') email = e;
  else if (Array.isArray(e) && e.length) email = typeof e[0] === 'string' ? e[0] : e[0]?.mailId ?? '';
  email ||= c.mailId ?? c.primaryEmailAddress ?? '';
  let host = 'mail.zoho.com';
  const base = c.mailAccountDetails?.[0]?.ApiBaseUrl;
  if (base) { try { host = new URL(base.startsWith('http') ? base : `https://${base}`).host || host; } catch { /* ok */ } }
  return { email: String(email).toLowerCase(), accountId: String(c.accountId), host };
}

async function carpetaEntrada(host: string, accountId: string, token: string) {
  const carpetas = await zohoGet(host, `/api/accounts/${accountId}/folders`, token);
  const inbox = (carpetas ?? []).find((f: Record<string, unknown>) =>
    String(f.folderType ?? '').toLowerCase() === 'inbox' || String(f.folderName ?? '').toLowerCase() === 'inbox');
  return inbox ? String(inbox.folderId) : null;
}

async function ultimosCorreos(host: string, accountId: string, folderId: string, token: string, limit = 10) {
  const q = new URLSearchParams({ folderId, limit: String(limit), start: '1' });
  return (await zohoGet(host, `/api/accounts/${accountId}/messages/view?${q}`, token)) ?? [];
}

// ─── Firebase Cloud Messaging (API v1) ─────────────────────────
let fcmCache: { token: string; expira: number; proyecto: string } | null = null;
const b64url = (u: Uint8Array | string) =>
  (typeof u === 'string' ? btoa(u) : b64(u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function tokenFirebase() {
  if (fcmCache && fcmCache.expira > Date.now() + 60_000) return fcmCache;
  const sa = JSON.parse(env('FIREBASE_SERVICE_ACCOUNT'));
  const ahora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600,
  }));
  const pem = String(sa.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', unb64(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const firma = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(firma)}` }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Firebase token: ${JSON.stringify(body)}`);
  fcmCache = { token: body.access_token, expira: Date.now() + (body.expires_in ?? 3600) * 1000, proyecto: sa.project_id };
  return fcmCache;
}

// Devuelve 'ok', 'token_invalido' o lanza error
async function enviarPush(fcmToken: string, titulo: string, cuerpo: string, datos: Record<string, string>) {
  const { token, proyecto } = await tokenFirebase();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${proyecto}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title: titulo, body: cuerpo },
        data: datos,
        android: {
          priority: 'high',
          notification: { channel_id: CANAL_ANDROID, tag: datos.messageId ?? 'pieba' },
        },
      },
    }),
  });
  if (res.ok) return 'ok';
  const txt = await res.text();
  if (res.status === 404 || txt.includes('UNREGISTERED') || (res.status === 400 && txt.includes('registration token'))) return 'token_invalido';
  throw new Error(`FCM ${res.status}: ${txt.slice(0, 200)}`);
}

// ─── Acciones ──────────────────────────────────────────────────
async function registrar(p: Record<string, string>) {
  if (!p.fcm_token || !p.access_token || !p.refresh_token) return json(400, { error: 'faltan_datos' });

  // 1. El access token prueba quién es
  const cuenta = await cuentaDelToken(p.access_token);
  if (!cuenta) return json(401, { error: 'token_invalido' });
  if (!cuenta.email.endsWith(`@${DOMINIO_PERMITIDO}`)) return json(403, { error: 'dominio_no_permitido' });

  // 2. El refresh token tiene que ser de la misma cuenta
  let nuevo;
  try { nuevo = await refrescarToken(p.refresh_token); } catch { return json(401, { error: 'refresh_invalido' }); }
  const cuenta2 = await cuentaDelToken(nuevo.token);
  if (!cuenta2 || cuenta2.email !== cuenta.email) return json(403, { error: 'cuentas_distintas' });

  // 3. Bandeja de entrada y punto de partida (no avisar correos viejos)
  const inbox = await carpetaEntrada(cuenta.host, cuenta.accountId, nuevo.token);
  if (!inbox) return json(502, { error: 'sin_bandeja' });
  const ultimos = await ultimosCorreos(cuenta.host, cuenta.accountId, inbox, nuevo.token, 1);
  const base = Math.max(0, ...ultimos.map((m: Record<string, unknown>) => Number(m.receivedTime) || 0));

  await db('POST', '?on_conflict=fcm_token', {
    fcm_token: p.fcm_token,
    email: cuenta.email,
    account_id: cuenta.accountId,
    api_host: cuenta.host,
    inbox_folder_id: inbox,
    refresh_token_cifrado: await cifrar(p.refresh_token),
    access_token_cifrado: await cifrar(nuevo.token),
    access_token_expira: new Date(nuevo.expira).toISOString(),
    ultimo_recibido: base,
    errores_seguidos: 0,
    ultimo_error: null,
    actualizado_en: new Date().toISOString(),
  }, 'resolution=merge-duplicates,return=minimal');

  return json(200, { ok: true, email: cuenta.email });
}

async function baja(p: Record<string, string>) {
  if (!p.fcm_token) return json(400, { error: 'faltan_datos' });
  await db('DELETE', `?fcm_token=eq.${encodeURIComponent(p.fcm_token)}`);
  return json(200, { ok: true });
}

type Dispositivo = {
  fcm_token: string; email: string; account_id: string; api_host: string; inbox_folder_id: string;
  refresh_token_cifrado: string; access_token_cifrado: string | null; access_token_expira: string | null;
  ultimo_recibido: number; errores_seguidos: number;
};

async function revisarDispositivo(d: Dispositivo) {
  const filtro = `?fcm_token=eq.${encodeURIComponent(d.fcm_token)}`;
  try {
    // Token de acceso vigente (se renueva solo cuando vence: Zoho limita las renovaciones)
    let token = d.access_token_cifrado ? await descifrar(d.access_token_cifrado) : '';
    const cambios: Record<string, unknown> = {};
    if (!token || !d.access_token_expira || new Date(d.access_token_expira).getTime() < Date.now() + 120_000) {
      const nuevo = await refrescarToken(await descifrar(d.refresh_token_cifrado));
      token = nuevo.token;
      cambios.access_token_cifrado = await cifrar(token);
      cambios.access_token_expira = new Date(nuevo.expira).toISOString();
    }

    const correos = await ultimosCorreos(d.api_host, d.account_id, d.inbox_folder_id, token);
    const nuevos = correos
      .filter((m: Record<string, unknown>) => (Number(m.receivedTime) || 0) > Number(d.ultimo_recibido) && String(m.status) !== '1')
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => Number(a.receivedTime) - Number(b.receivedTime));
    const maxVisto = Math.max(Number(d.ultimo_recibido), ...correos.map((m: Record<string, unknown>) => Number(m.receivedTime) || 0));

    let enviados = 0;
    if (nuevos.length > 3) {
      const r = await enviarPush(d.fcm_token, `${nuevos.length} correos nuevos`, nuevos.slice(-3).map((m: Record<string, unknown>) => m.sender || m.fromAddress).join(', '), { tipo: 'varios' });
      if (r === 'token_invalido') { await db('DELETE', filtro); return { email: d.email, baja: true }; }
      enviados = 1;
    } else {
      for (const m of nuevos) {
        const r = await enviarPush(
          d.fcm_token,
          String(m.sender || m.fromAddress || 'Nuevo correo'),
          String(m.subject || '(Sin asunto)'),
          { tipo: 'correo', messageId: String(m.messageId), folderId: String(m.folderId ?? d.inbox_folder_id) },
        );
        if (r === 'token_invalido') { await db('DELETE', filtro); return { email: d.email, baja: true }; }
        enviados++;
      }
    }

    await db('PATCH', filtro, { ...cambios, ultimo_recibido: maxVisto, errores_seguidos: 0, ultimo_error: null }, 'return=minimal');
    return { email: d.email, enviados };
  } catch (e) {
    const err = e as Error & { revocado?: boolean };
    const errores = (d.errores_seguidos ?? 0) + 1;
    // Acceso revocado en Zoho, o falla persistente (~1 h): dar de baja
    if (err.revocado || errores >= 60) { await db('DELETE', filtro); return { email: d.email, baja: true, error: err.message }; }
    await db('PATCH', filtro, { errores_seguidos: errores, ultimo_error: err.message.slice(0, 300) }, 'return=minimal');
    return { email: d.email, error: err.message };
  }
}

async function revisar() {
  const dispositivos: Dispositivo[] = await db('GET', '?select=*&order=actualizado_en.asc&limit=500');
  const resultados = [];
  // De a 5 en paralelo para no saturar a Zoho
  for (let i = 0; i < dispositivos.length; i += 5) {
    const lote = await Promise.allSettled(dispositivos.slice(i, i + 5).map(revisarDispositivo));
    for (const r of lote) resultados.push(r.status === 'fulfilled' ? r.value : { error: String(r.reason) });
  }
  return json(200, { revisados: dispositivos.length, resultados });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  let p: Record<string, string>;
  try { p = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  try {
    if (p.accion === 'revisar') {
      if (!env('MAIL_CRON_SECRET') || req.headers.get('x-cron-secret') !== env('MAIL_CRON_SECRET')) return json(401, { error: 'no_autorizado' });
      return await revisar();
    }
    if (p.accion === 'registrar') return await registrar(p);
    if (p.accion === 'baja') return await baja(p);
    return json(400, { error: 'accion_desconocida' });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'error_interno' });
  }
});
