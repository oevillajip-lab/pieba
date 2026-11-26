// ════════════════════════════════════════════════════════════════
//  PIEBA Mail · Avisos de la app y datos compartidos
// ════════════════════════════════════════════════════════════════
//  - Perfil, preferencias, plantillas, comunicados y estado (la app).
//  - "revisar" (pg_cron, cada minuto): envía los comunicados programados.
//  Los avisos de correo nuevo los manda la función "buzon" al instante.
//
//  Secretos: FIREBASE_SERVICE_ACCOUNT, MAIL_CRON_SECRET.
//  SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase solo.
//  Al desplegar: desactivar "Verify JWT".
// ════════════════════════════════════════════════════════════════
const CANAL_ANDROID = 'pieba_mail_channel';
const CANAL_AVISOS = 'pieba_avisos_channel';

const env = (k: string) => Deno.env.get(k) ?? '';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });

// ─── Base de datos (REST con la clave de servicio) ──────────────
async function dbt(tabla: string, method: string, query: string, body?: unknown, prefer?: string) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${tabla}${query}`, {
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

// ─── Firebase Cloud Messaging (API v1) ─────────────────────────
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
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
async function enviarPush(fcmToken: string, titulo: string, cuerpo: string, datos: Record<string, string>, canal = CANAL_ANDROID) {
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
          notification: { channel_id: canal, tag: datos.messageId ?? datos.id ?? 'pieba' },
        },
      },
    }),
  });
  if (res.ok) return 'ok';
  const txt = await res.text();
  if (res.status === 404 || txt.includes('UNREGISTERED') || (res.status === 400 && txt.includes('registration token'))) return 'token_invalido';
  throw new Error(`FCM ${res.status}: ${txt.slice(0, 200)}`);
}

// ─── Cada minuto (pg_cron): comunicados programados ───────────
async function revisar() {
  const comunicados = await enviarComunicados().catch((e) => ({ error: String(e) }));
  return json(200, { comunicados });
}

// ─── Datos de la app ───────────────────────────────────────────
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';

function versionYPreferencias(p: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (num(p.version_code) !== null) out.version_code = num(p.version_code);
  if (typeof p.version_nombre === 'string') out.version_nombre = p.version_nombre.slice(0, 40);
  for (const k of ['avisos_correo', 'avisos_comunicados', 'avisos_actualizacion']) {
    if (k in p) out[k] = bool(p[k]);
  }
  return out;
}

// Quién es (por su sesión). Cache corto para no consultar en cada llamada.
const cacheCuentas = new Map<string, { email: string; hasta: number }>();
// Sesión del correo propio (Supabase): el token es un JWT.
async function emailDeSesionPropia(token: string) {
  const r = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const email = String((await r.json()).email ?? '').toLowerCase();
  const b = await dbt('buzones', 'GET', `?select=email&activo=eq.true&email=eq.${encodeURIComponent(email)}`);
  return b?.length ? email : null;
}

async function quien(p: Record<string, unknown>) {
  const token = typeof p.access_token === 'string' ? p.access_token : '';
  if (!token || token.split('.').length !== 3) return null;
  const c = cacheCuentas.get(token);
  if (c && c.hasta > Date.now()) return c.email;
  const e = await emailDeSesionPropia(token);
  if (!e) return null;
  if (cacheCuentas.size > 500) cacheCuentas.clear();
  cacheCuentas.set(token, { email: e, hasta: Date.now() + 5 * 60_000 });
  return e;
}

async function esAdminApp(email: string) {
  const r = await dbt('mail_admins', 'GET', `?select=email&email=eq.${encodeURIComponent(email)}`);
  return Array.isArray(r) && r.length > 0;
}

async function configApp() {
  const filas: { clave: string; valor: unknown }[] = await dbt('mail_config', 'GET', '?select=clave,valor');
  return Object.fromEntries((filas ?? []).map((f) => [f.clave, f.valor]));
}

type Comunicado = {
  id: string; tipo: string; titulo: string; contenido: string; imagen_url: string | null;
  destino: string; destino_emails: string[] | null; version_code: number | null;
  programado_para: string; enviado_en: string | null; creado_en: string;
};

function comunicadoPara(c: Comunicado, email: string, version: number | null) {
  if (c.destino === 'usuarios') return (c.destino_emails ?? []).map((e) => e.toLowerCase()).includes(email);
  if (c.destino === 'version_vieja') return c.version_code != null && version != null && version < c.version_code;
  if (c.destino === 'version_nueva') return c.version_code != null && version != null && version >= c.version_code;
  return true;
}

async function comunicadosDe(email: string, version: number | null, limite = 50) {
  const ahora = new Date().toISOString();
  const lista: Comunicado[] = await dbt('mail_comunicados', 'GET',
    `?select=id,tipo,titulo,contenido,imagen_url,destino,destino_emails,version_code,programado_para,enviado_en,creado_en` +
    `&activo=eq.true&programado_para=lte.${encodeURIComponent(ahora)}&order=programado_para.desc&limit=200`);
  const vistos: { comunicado_id: string }[] = await dbt('mail_comunicados_vistos', 'GET',
    `?select=comunicado_id&email=eq.${encodeURIComponent(email)}`);
  const vistosSet = new Set((vistos ?? []).map((v) => v.comunicado_id));
  return (lista ?? [])
    .filter((c) => comunicadoPara(c, email, version))
    .slice(0, limite)
    .map((c) => ({
      id: c.id, tipo: c.tipo, titulo: c.titulo, contenido: c.contenido, imagen_url: c.imagen_url,
      fecha: c.programado_para, visto: vistosSet.has(c.id),
    }));
}

async function accionApp(p: Record<string, unknown>) {
  const email = await quien(p);
  if (!email) return json(401, { error: 'token_invalido' });
  const version = num(p.version_code);

  switch (p.accion) {
    case 'perfil': {
      if (typeof p.fcm_token === 'string' && p.fcm_token) {
        await dbt('buzon_dispositivos', 'PATCH', `?fcm_token=eq.${encodeURIComponent(p.fcm_token)}&email=eq.${encodeURIComponent(email)}`,
          { ultimo_uso: new Date().toISOString(), ...versionYPreferencias({ version_code: p.version_code, version_nombre: p.version_nombre }) },
          'return=minimal').catch(() => {});
      }
      const [admin, config, comunicados] = await Promise.all([esAdminApp(email), configApp(), comunicadosDe(email, version, 20)]);
      return json(200, { email, es_admin: admin, config, comunicados_pendientes: comunicados.filter((c) => !c.visto) });
    }
    case 'preferencias': {
      if (typeof p.fcm_token !== 'string' || !p.fcm_token) return json(400, { error: 'faltan_datos' });
      await dbt('buzon_dispositivos', 'PATCH', `?fcm_token=eq.${encodeURIComponent(p.fcm_token)}&email=eq.${encodeURIComponent(email)}`,
        versionYPreferencias(p), 'return=minimal');
      return json(200, { ok: true });
    }
    case 'comunicados':
      return json(200, { comunicados: await comunicadosDe(email, version) });
    case 'comunicado_visto': {
      if (typeof p.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.id)) return json(400, { error: 'faltan_datos' });
      await dbt('mail_comunicados_vistos', 'POST', '?on_conflict=comunicado_id,email',
        { comunicado_id: p.id, email }, 'resolution=ignore-duplicates,return=minimal');
      return json(200, { ok: true });
    }
    case 'plantillas': {
      const filas = await dbt('mail_plantillas', 'GET',
        `?select=id,nombre,asunto,cuerpo,borrada,actualizado_en&email=eq.${encodeURIComponent(email)}&order=actualizado_en.asc`);
      return json(200, { plantillas: filas ?? [] });
    }
    case 'plantilla_guardar':
    case 'plantilla_borrar': {
      const id = typeof p.id === 'string' ? p.id.slice(0, 80) : '';
      if (!id) return json(400, { error: 'faltan_datos' });
      const fila: Record<string, unknown> = {
        id, email, borrada: p.accion === 'plantilla_borrar',
        actualizado_en: typeof p.actualizado_en === 'string' ? p.actualizado_en : new Date().toISOString(),
      };
      if (p.accion === 'plantilla_guardar') {
        fila.nombre = String(p.nombre ?? '').slice(0, 200);
        fila.asunto = String(p.asunto ?? '').slice(0, 500);
        fila.cuerpo = String(p.cuerpo ?? '').slice(0, 50_000);
      }
      await dbt('mail_plantillas', 'POST', '?on_conflict=email,id', fila, 'resolution=merge-duplicates,return=minimal');
      return json(200, { ok: true });
    }
    case 'admin_estado': {
      if (!(await esAdminApp(email))) return json(403, { error: 'solo_admin' });
      const dispositivos: Record<string, unknown>[] = ((await dbt('buzon_dispositivos', 'GET',
        '?select=email,version_code,version_nombre,ultimo_uso,avisos_correo,avisos_comunicados&order=email.asc')) ?? []);
      const pendientes = await dbt('mail_comunicados', 'GET', '?select=id&enviado_en=is.null&activo=eq.true');
      return json(200, {
        servidor: 'ok', hora: new Date().toISOString(),
        dispositivos: dispositivos ?? [], comunicados_pendientes: (pendientes ?? []).length,
        config: await configApp(),
      });
    }
  }
  return json(400, { error: 'accion_desconocida' });
}

// ─── Envío de comunicados (lo llama "revisar", cada minuto) ────
async function enviarComunicados() {
  const ahora = new Date().toISOString();
  // Se "reservan" marcando enviado_en primero: así nunca se mandan dos veces.
  const listos: Comunicado[] = await dbt('mail_comunicados', 'PATCH',
    `?enviado_en=is.null&activo=eq.true&programado_para=lte.${encodeURIComponent(ahora)}`,
    { enviado_en: ahora }, 'return=representation');
  if (!listos?.length) return { enviados: 0 };

  const dispositivos: { fcm_token: string; email: string; version_code: number | null;
    avisos_comunicados: boolean; avisos_actualizacion: boolean }[] =
    (await dbt('buzon_dispositivos', 'GET', '?select=fcm_token,email,version_code,avisos_comunicados,avisos_actualizacion')) ?? [];

  const resumen = [];
  for (const c of listos) {
    let enviados = 0;
    const yaAvisados = new Set<string>(); // un aviso por teléfono aunque tenga varias cuentas
    const cuerpo = String(c.contenido ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    for (const d of dispositivos ?? []) {
      if (!comunicadoPara(c, d.email, d.version_code)) continue;
      const quiere = c.tipo === 'actualizacion' ? d.avisos_actualizacion !== false : d.avisos_comunicados !== false;
      if (!quiere || yaAvisados.has(d.fcm_token)) continue;
      yaAvisados.add(d.fcm_token);
      try {
        const r = await enviarPush(d.fcm_token, c.titulo, cuerpo || 'Tocá para ver el comunicado', { tipo: 'comunicado', id: c.id }, CANAL_AVISOS);
        if (r === 'token_invalido') {
          await dbt('buzon_dispositivos', 'DELETE', `?fcm_token=eq.${encodeURIComponent(d.fcm_token)}`).catch(() => {});
        } else enviados++;
      } catch (e) { console.error('comunicado', c.id, e); }
    }
    await dbt('mail_comunicados', 'PATCH', `?id=eq.${c.id}`, { enviados }, 'return=minimal');
    resumen.push({ id: c.id, enviados });
  }
  return resumen;
}


// El panel web llama directo desde el navegador: permitir CORS.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  // deno-lint-ignore no-explicit-any
  let p: Record<string, any>;
  try { p = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  try {
    if (p.accion === 'revisar') {
      if (!env('MAIL_CRON_SECRET') || req.headers.get('x-cron-secret') !== env('MAIL_CRON_SECRET')) return json(401, { error: 'no_autorizado' });
      return await revisar();
    }
    return await accionApp(p);
  } catch (e) {
    console.error(e);
    return json(500, { error: 'error_interno' });
  }
});
