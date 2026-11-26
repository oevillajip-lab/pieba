// ═══════════════════════════════════════════════════════════════════
//  PIEBA Mail · Correo propio (sin Zoho)
// ═══════════════════════════════════════════════════════════════════
//  Una sola función para todo el correo:
//   · Sin sesión: login (contraseña o clave de un solo uso), refresh,
//     olvide, crear_clave (primer ingreso, con correo de recuperación).
//   · Panel, solo superadmin: clave_temporal, eliminar_buzon.
//   · Con sesión (access_token de Supabase): carpetas, listar, buscar,
//     detalle, adjuntos, descargar, actualizar, eliminar, vaciar, enviar,
//     subir, contactos, contacto_guardar, contacto_borrar, registrar, baja,
//     preferencias.
//   · Desde Cloudflare (header x-buzon-secreto): entrante_destino,
//     entrante_subir, entrante.
//
//  Secretos (Supabase → Edge Functions → Secrets):
//    RESEND_API_KEY            clave de Resend (para enviar)
//    BUZON_SECRETO             texto al azar, el mismo en Cloudflare
//    FIREBASE_SERVICE_ACCOUNT  (ya cargado) para los avisos
//  SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase solo.
//
//  Al desplegar: desactivar "Verify JWT" (la función valida la sesión).
// ═══════════════════════════════════════════════════════════════════

const BUCKET = 'correo';
const CANAL_CORREO = 'pieba_mail_channel';
const TOPE_DIARIO = 95; // Resend gratis: 100/día (dejamos margen)
const CARPETAS: Record<string, string> = {
  inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', spam: 'Spam', trash: 'Trash', archive: 'Archive',
};

const env = (k: string) => Deno.env.get(k) ?? '';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const enc = encodeURIComponent;

// ─── Base de datos / Storage / Auth (con la clave de servicio) ──────
function cabeceras(extra: Record<string, string> = {}) {
  const k = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...extra };
}
async function db(tabla: string, method: string, query = '', body?: unknown, prefer?: string) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${tabla}${query}`, {
    method, headers: cabeceras(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DB ${tabla} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
async function rpc(fn: string, args: unknown) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, { method: 'POST', headers: cabeceras(), body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`RPC ${fn} ${res.status}`);
  return res.json();
}
async function auth(path: string, method: string, body?: unknown) {
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1${path}`, {
    method, headers: cabeceras(), body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  return { ok: res.ok, status: res.status, data: t ? JSON.parse(t) : null };
}
async function firmarDescarga(ruta: string, segundos = 300) {
  const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/sign/${BUCKET}/${ruta}`, {
    method: 'POST', headers: cabeceras(), body: JSON.stringify({ expiresIn: segundos }),
  });
  if (!res.ok) throw new Error(`Storage firmar ${res.status}`);
  const { signedURL } = await res.json();
  return `${env('SUPABASE_URL')}/storage/v1${signedURL}`;
}
async function firmarSubida(ruta: string) {
  const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/upload/sign/${BUCKET}/${ruta}`, {
    method: 'POST', headers: cabeceras(),
  });
  if (!res.ok) throw new Error(`Storage subida ${res.status}: ${await res.text()}`);
  const { url } = await res.json();
  return `${env('SUPABASE_URL')}/storage/v1${url}`;
}
async function borrarArchivos(rutas: string[]) {
  if (!rutas.length) return;
  await fetch(`${env('SUPABASE_URL')}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE', headers: cabeceras(), body: JSON.stringify({ prefixes: rutas }),
  });
}

// ─── Utilidades ─────────────────────────────────────────────────────
const limpiarEmail = (s: unknown) => String(s ?? '').trim().toLowerCase();
const emailsDe = (s: unknown) =>
  [...String(s ?? '').matchAll(/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());
const escaparHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textoPlano = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
async function sha256(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function dominios(): Promise<string[]> {
  const filas: { dominio: string }[] = await db('buzon_dominios', 'GET', '?select=dominio');
  return filas.map((f) => f.dominio);
}
async function buzonActivo(email: string) {
  const r = await db('buzones', 'GET', `?select=email,nombre,correo_personal,activo&email=eq.${enc(email)}`);
  return r?.[0]?.activo ? r[0] as { email: string; nombre: string; correo_personal: string | null } : null;
}

// Forma "tipo Zoho" que ya entiende la app (así no cambia su lógica).
type Correo = Record<string, unknown>;
function aLista(c: Correo) {
  const t = new Date(String(c.recibido_en)).getTime();
  return {
    messageId: c.id, folderId: c.carpeta, subject: c.asunto,
    sender: c.de_nombre || String(c.de).split('@')[0], fromAddress: c.de,
    toAddress: c.para, ccAddress: c.cc, summary: c.resumen,
    receivedTime: String(t), sentDateInGMT: String(t),
    isRead: c.leido, status: c.leido ? '1' : '0',
    hasAttachment: c.tiene_adjuntos ? '1' : '0',
  };
}
const CAMPOS_LISTA = 'id,carpeta,asunto,de,de_nombre,para,cc,resumen,recibido_en,leido,tiene_adjuntos';

// ─── Sesión ─────────────────────────────────────────────────────────
async function quien(p: Record<string, unknown>) {
  const token = String(p.access_token ?? '');
  if (!token) return null;
  const r = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  const email = limpiarEmail(u.email);
  return (await buzonActivo(email)) ? email : null;
}
async function sesionPorPassword(email: string, password: string) {
  const r = await auth('/token?grant_type=password', 'POST', { email, password });
  if (!r.ok) return null;
  return { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_in: r.data.expires_in };
}

// ─── Envío con Resend ───────────────────────────────────────────────
async function resend(body: unknown) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}
function plantillaRecuperar(email: string, clave: string, nombre: string) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#07051e;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#07051e;padding:40px 16px;"><tr><td align="center">
  <table width="460" cellpadding="0" cellspacing="0" style="max-width:460px;background:#0f0b32;border:1px solid rgba(201,169,110,.35);border-radius:6px;">
  <tr><td style="padding:32px 32px 8px;text-align:center;color:#c9a96e;letter-spacing:3px;font-size:12px;">PIEBA MAIL</td></tr>
  <tr><td style="padding:8px 32px;text-align:center;color:#fff;font-size:20px;">Recuperar tu cuenta</td></tr>
  <tr><td style="padding:8px 32px 0;text-align:center;color:rgba(255,255,255,.7);font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">
    Hola${nombre ? ` ${escaparHtml(nombre)}` : ''}. Para entrar a <b style="color:#fff;">${escaparHtml(email)}</b>, abrí PIEBA Mail e ingresá con esta clave de acceso. Después vas a crear una contraseña nueva.</td></tr>
  <tr><td style="padding:24px 32px;text-align:center;"><span style="display:inline-block;padding:14px 22px;border:1px solid #c9a96e;border-radius:4px;color:#c9a96e;font-size:26px;letter-spacing:6px;font-family:'Courier New',monospace;">${clave}</span></td></tr>
  <tr><td style="padding:0 32px 32px;text-align:center;color:rgba(255,255,255,.5);font-family:Arial,sans-serif;font-size:12px;">
    Sirve una sola vez y vence en 1 hora. Si no lo pediste, ignorá este mensaje: tu contraseña actual sigue funcionando.</td></tr>
  </table></td></tr></table></body></html>`;
}

// ─── Avisos (Firebase) ──────────────────────────────────────────────
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u: Uint8Array | string) =>
  (typeof u === 'string' ? btoa(u) : b64(u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let fcmCache: { token: string; expira: number; proyecto: string } | null = null;
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
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(firma)}` }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Firebase token: ${JSON.stringify(body)}`);
  fcmCache = { token: body.access_token, expira: Date.now() + (body.expires_in ?? 3600) * 1000, proyecto: sa.project_id };
  return fcmCache;
}
async function enviarPush(fcmToken: string, titulo: string, cuerpo: string, datos: Record<string, string>) {
  const { token, proyecto } = await tokenFirebase();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${proyecto}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: {
      token: fcmToken, notification: { title: titulo, body: cuerpo }, data: datos,
      android: { priority: 'high', notification: { channel_id: CANAL_CORREO, tag: datos.messageId ?? 'pieba' } },
    } }),
  });
  if (res.ok) return 'ok';
  const txt = await res.text();
  if (res.status === 404 || txt.includes('UNREGISTERED') || (res.status === 400 && txt.includes('registration token'))) return 'token_invalido';
  throw new Error(`FCM ${res.status}: ${txt.slice(0, 200)}`);
}
async function avisarCorreoNuevo(email: string, c: Correo) {
  const dispositivos: { fcm_token: string; avisos_correo: boolean }[] =
    await db('buzon_dispositivos', 'GET', `?select=fcm_token,avisos_correo&email=eq.${enc(email)}`);
  for (const d of dispositivos ?? []) {
    if (d.avisos_correo === false) continue;
    // ¿Este teléfono tiene más de una cuenta? Entonces decir a cuál llegó.
    const otras: unknown[] = await db('buzon_dispositivos', 'GET', `?select=email&fcm_token=eq.${enc(d.fcm_token)}`);
    const para = (otras?.length ?? 0) > 1 ? ` · para ${email.split('@')[0]}` : '';
    try {
      const r = await enviarPush(d.fcm_token, String(c.de_nombre || c.de), `${c.asunto || '(Sin asunto)'}${para}`,
        { tipo: 'correo', messageId: String(c.id), folderId: 'inbox', email });
      if (r === 'token_invalido') await db('buzon_dispositivos', 'DELETE', `?fcm_token=eq.${enc(d.fcm_token)}`);
    } catch (e) { console.error('push', e); }
  }
}

// ─── Acciones sin sesión ────────────────────────────────────────────
async function sinSesion(p: Record<string, unknown>) {
  const email = limpiarEmail(p.email);
  switch (p.accion) {
    case 'login': {
      const b = await buzonActivo(email);
      const password = String(p.password ?? '');
      if (!b) return json(401, { error: 'credenciales', mensaje: 'Correo o contraseña incorrectos.' });
      const s = await sesionPorPassword(email, password);
      if (s) return json(200, { ...s, email, nombre: b.nombre });
      // ¿Es la clave de un solo uso que dio el administrador?
      const t = await claveTemporal(email, password);
      if (t === 'ok') return json(200, { requiere_cambio: true, email, nombre: b.nombre, correo_recuperacion: b.correo_personal ?? '' });
      if (t === 'vencida') return json(401, { error: 'temporal_vencida', mensaje: 'Esa clave de acceso venció. Pedí una nueva al administrador.' });
      return json(401, { error: 'credenciales', mensaje: 'Correo o contraseña incorrectos.' });
    }
    case 'refresh': {
      const r = await auth('/token?grant_type=refresh_token', 'POST', { refresh_token: String(p.refresh_token ?? '') });
      if (!r.ok) return json(401, { error: 'sesion_vencida' });
      const e = limpiarEmail(r.data.user?.email);
      if (!(await buzonActivo(e))) return json(403, { error: 'cuenta_inactiva' });
      return json(200, { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_in: r.data.expires_in, email: e });
    }
    // Olvidé mi contraseña: manda una clave de acceso al correo de
    // recuperación. Responde igual exista o no (no revela cuentas).
    case 'olvide': {
      const b = await buzonActivo(email);
      if (b?.correo_personal) {
        const previa = (await db('buzon_pines', 'GET', `?select=creado_en&email=eq.${enc(email)}`))?.[0];
        const reciente = previa && Date.now() - new Date(previa.creado_en).getTime() < 2 * 60_000;
        if (!reciente) {
          const clave = nuevaClaveTemporal();
          await db('buzon_pines', 'POST', '?on_conflict=email', {
            email, pin_hash: await hashTemporal(email, clave),
            expira_en: new Date(Date.now() + 60 * 60_000).toISOString(), intentos: 0, creado_en: new Date().toISOString(),
          }, 'resolution=merge-duplicates,return=minimal');
          const dominio = email.split('@')[1].replace(/^prueba\./, '');
          await resend({
            from: `PIEBA Mail <no-responder@${dominio}>`, to: [b.correo_personal],
            subject: 'Recuperar tu cuenta de PIEBA Mail', html: plantillaRecuperar(email, clave, b.nombre),
          });
        }
      }
      return json(200, { ok: true });
    }
    // Primer ingreso: con la clave de un solo uso crea su contraseña.
    case 'crear_clave': {
      const password = String(p.password ?? '');
      if (password.length < 8) return json(400, { error: 'password_corta', mensaje: 'La contraseña debe tener al menos 8 caracteres.' });
      const b = await buzonActivo(email);
      if (!b) return json(401, { error: 'credenciales', mensaje: 'Correo o contraseña incorrectos.' });
      const t = await claveTemporal(email, String(p.temporal ?? ''));
      if (t !== 'ok') return json(401, { error: 'temporal_vencida', mensaje: 'La clave de acceso ya no es válida. Pedí una nueva al administrador.' });
      if (password === String(p.temporal ?? '')) return json(400, { error: 'igual', mensaje: 'Elegí una contraseña distinta a la clave de acceso.' });
      const recuperacion = limpiarEmail(p.correo_recuperacion);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recuperacion)) return json(400, { error: 'recuperacion', mensaje: 'Escribí un correo de recuperación válido.' });
      if ((await dominios()).includes(recuperacion.split('@')[1])) {
        return json(400, { error: 'recuperacion', mensaje: 'El correo de recuperación tiene que ser personal (Gmail, Hotmail, etc.), no de la iglesia.' });
      }
      const id = await rpc('buzon_user_id', { p_email: email });
      const r = id
        ? await auth(`/admin/users/${id}`, 'PUT', { password })
        : await auth('/admin/users', 'POST', { email, password, email_confirm: true });
      if (!r.ok) return json(500, { error: 'cuenta', mensaje: 'No se pudo guardar la contraseña.' });
      await db('buzon_pines', 'DELETE', `?email=eq.${enc(email)}`);
      await db('buzones', 'PATCH', `?email=eq.${enc(email)}`, { correo_personal: recuperacion }, 'return=minimal');
      // Si tenía correos en Zoho, se copian solos en segundo plano.
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil(fetch(`${env('SUPABASE_URL')}/functions/v1/mail-push`, {
        method: 'POST',
        headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), 'Content-Type': 'application/json', 'x-buzon-secreto': env('BUZON_SECRETO') },
        body: JSON.stringify({ accion: 'migrar_zoho', email, auto: true }),
      }).catch((e) => console.error('migrar', e)));
      const s = await sesionPorPassword(email, password);
      return json(200, { ...s, email, nombre: b.nombre });
    }
  }
  return null;
}

// Clave de un solo uso: 8 caracteres fáciles de dictar (sin 0/O ni 1/I/L).
const LETRAS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function nuevaClaveTemporal() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const t = [...r].map((x) => LETRAS[x % LETRAS.length]).join('');
  return `${t.slice(0, 4)}-${t.slice(4)}`;
}
const normalizarTemporal = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
async function hashTemporal(email: string, t: string) {
  return sha256(`${normalizarTemporal(t)}|${email}|${env('BUZON_SECRETO')}`);
}
async function claveTemporal(email: string, t: string): Promise<'ok' | 'vencida' | 'no'> {
  if (normalizarTemporal(t).length !== 8) return 'no';
  const f = (await db('buzon_pines', 'GET', `?email=eq.${enc(email)}`))?.[0];
  if (!f) return 'no';
  if (f.intentos >= 10) return 'vencida';
  if (await hashTemporal(email, t) !== f.pin_hash) {
    await db('buzon_pines', 'PATCH', `?email=eq.${enc(email)}`, { intentos: f.intentos + 1 }, 'return=minimal');
    return 'no';
  }
  return new Date(f.expira_en).getTime() < Date.now() ? 'vencida' : 'ok';
}

// ─── Panel (solo superadmin) ────────────────────────────────────────
async function esSuperadmin(req: Request) {
  const a = req.headers.get('Authorization') ?? '';
  if (!a.startsWith('Bearer ')) return false;
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/es_superadmin`, {
    method: 'POST', headers: { apikey: env('SUPABASE_ANON_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: a, 'Content-Type': 'application/json' }, body: '{}',
  });
  return r.ok && (await r.json()) === true;
}
async function panel(p: Record<string, unknown>) {
  const email = limpiarEmail(p.email);
  if (p.accion === 'clave_temporal') {
    const b = await db('buzones', 'GET', `?select=email&email=eq.${enc(email)}`);
    if (!b?.length) return json(404, { error: 'no_existe', mensaje: 'Esa cuenta no existe.' });
    const clave = nuevaClaveTemporal();
    await db('buzon_pines', 'POST', '?on_conflict=email', {
      email, pin_hash: await hashTemporal(email, clave),
      expira_en: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(), intentos: 0, creado_en: new Date().toISOString(),
    }, 'resolution=merge-duplicates,return=minimal');
    return json(200, { clave, vence: '7 días' });
  }
  if (p.accion === 'eliminar_buzon') {
    const b = await db('buzones', 'GET', `?select=email&email=eq.${enc(email)}`);
    if (!b?.length) return json(404, { error: 'no_existe', mensaje: 'Esa cuenta no existe.' });
    // Archivos adjuntos guardados (carpetas recibidos/salida/zoho de la cuenta).
    const rutas: string[] = [];
    const listar = async (prefijo: string) => {
      const r = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/list/correo`, {
        method: 'POST', headers: cabeceras(), body: JSON.stringify({ prefix: prefijo, limit: 1000 }),
      });
      const items: { name: string; id: string | null }[] = r.ok ? await r.json() : [];
      for (const it of items) {
        if (it.id) rutas.push(`${prefijo}${it.name}`);
        else await listar(`${prefijo}${it.name}/`);
      }
    };
    await listar(`${email}/`).catch((e) => console.error('listar', e));
    for (let i = 0; i < rutas.length; i += 100) {
      await fetch(`${env('SUPABASE_URL')}/storage/v1/object/correo`, {
        method: 'DELETE', headers: cabeceras(), body: JSON.stringify({ prefixes: rutas.slice(i, i + 100) }),
      }).catch((e) => console.error('borrar archivos', e));
    }
    const id = await rpc('buzon_user_id', { p_email: email });
    if (id) await auth(`/admin/users/${id}`, 'DELETE');
    await db('buzones', 'DELETE', `?email=eq.${enc(email)}`); // borra correos, contactos, etc.
    return json(200, { ok: true, archivos: rutas.length });
  }
  return json(400, { error: 'accion_desconocida' });
}

// ─── Acciones con sesión ────────────────────────────────────────────
async function conSesion(email: string, p: Record<string, unknown>) {
  const ids = (Array.isArray(p.ids) ? p.ids : [p.id]).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const filtroIds = `id=in.(${ids.join(',')})&buzon=eq.${enc(email)}`;
  switch (p.accion) {
    case 'cuenta': {
      const b = await buzonActivo(email);
      return json(200, { email, nombre: b?.nombre ?? '' });
    }
    case 'carpetas': {
      const noLeidos: { carpeta: string }[] = await db('correos', 'GET',
        `?select=carpeta&buzon=eq.${enc(email)}&leido=is.false&carpeta=in.(inbox,spam,archive)`);
      return json(200, Object.entries(CARPETAS).map(([id, nombre]) => ({
        folderId: id, folderName: nombre, folderType: nombre,
        unreadCount: (noLeidos ?? []).filter((x) => x.carpeta === id).length,
      })));
    }
    case 'listar': {
      const carpeta = String(p.carpeta ?? 'inbox');
      if (!CARPETAS[carpeta]) return json(400, { error: 'carpeta' });
      const desde = Math.max(0, (Number(p.start) || 1) - 1);
      const limite = Math.min(200, Math.max(1, Number(p.limit) || 50));
      const filas: Correo[] = await db('correos', 'GET',
        `?select=${CAMPOS_LISTA}&buzon=eq.${enc(email)}&carpeta=eq.${carpeta}&order=recibido_en.desc&offset=${desde}&limit=${limite}`);
      return json(200, (filas ?? []).map(aLista));
    }
    case 'buscar': {
      const q = String(p.q ?? '').replace(/[%,()*]/g, ' ').trim();
      if (!q) return json(200, []);
      const t = `*${q}*`;
      const filas: Correo[] = await db('correos', 'GET',
        `?select=${CAMPOS_LISTA}&buzon=eq.${enc(email)}&carpeta=neq.trash` +
        `&or=(asunto.ilike.${enc(t)},de.ilike.${enc(t)},de_nombre.ilike.${enc(t)},para.ilike.${enc(t)},resumen.ilike.${enc(t)})` +
        `&order=recibido_en.desc&limit=${Math.min(100, Number(p.limit) || 50)}`);
      return json(200, (filas ?? []).map(aLista));
    }
    case 'detalle': {
      const f: Correo[] = await db('correos', 'GET', `?select=*&${filtroIds}`);
      const c = f?.[0];
      if (!c) return json(404, { error: 'no_existe' });
      const html = String(c.html || '') || `<div style="white-space:pre-wrap">${escaparHtml(String(c.texto || ''))}</div>`;
      return json(200, { ...aLista(c), content: html, bccAddress: c.cco, replyTo: c.responder_a, messageIdHeader: c.message_id, references: c.referencias });
    }
    case 'adjuntos': {
      if (!ids.length) return json(200, []);
      const propio = await db('correos', 'GET', `?select=id&${filtroIds}`);
      if (!propio?.length) return json(200, []);
      const a: Correo[] = await db('correo_adjuntos', 'GET', `?select=id,nombre,tipo,tamano,cid&correo_id=eq.${ids[0]}&order=creado_en.asc`);
      return json(200, (a ?? []).map((x) => ({ attachmentId: x.id, attachmentName: x.nombre, size: x.tamano, cid: x.cid, contentType: x.tipo })));
    }
    case 'descargar': {
      const attId = String(p.adjunto ?? '');
      const a: { ruta: string; correo_id: string }[] = await db('correo_adjuntos', 'GET', `?select=ruta,correo_id&id=eq.${enc(attId)}`);
      if (!a?.length) return json(404, { error: 'no_existe' });
      const propio = await db('correos', 'GET', `?select=id&id=eq.${a[0].correo_id}&buzon=eq.${enc(email)}`);
      if (!propio?.length) return json(404, { error: 'no_existe' });
      return json(200, { url: await firmarDescarga(a[0].ruta) });
    }
    case 'actualizar': {
      if (!ids.length) return json(400, { error: 'faltan_datos' });
      const cambios: Record<string, unknown> = { actualizado_en: new Date().toISOString() };
      if (p.leido !== undefined) cambios.leido = p.leido === true;
      if (p.carpeta !== undefined) {
        if (!CARPETAS[String(p.carpeta)]) return json(400, { error: 'carpeta' });
        cambios.carpeta = String(p.carpeta);
      }
      await db('correos', 'PATCH', `?${filtroIds}`, cambios, 'return=minimal');
      return json(200, { ok: true });
    }
    case 'eliminar': {
      if (!ids.length) return json(400, { error: 'faltan_datos' });
      await eliminarCorreos(`?${filtroIds}`);
      return json(200, { ok: true });
    }
    case 'vaciar': {
      const carpeta = String(p.carpeta ?? '');
      if (!['trash', 'spam'].includes(carpeta)) return json(400, { error: 'carpeta' });
      await eliminarCorreos(`?buzon=eq.${enc(email)}&carpeta=eq.${carpeta}`);
      return json(200, { ok: true });
    }
    case 'subir': {
      const nombre = String(p.nombre ?? 'adjunto').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
      const ruta = `${email}/salida/${crypto.randomUUID()}/${nombre}`;
      return json(200, { ruta, url: await firmarSubida(ruta) });
    }
    case 'enviar': return await enviar(email, p);
    case 'contactos': {
      const c: Correo[] = await db('buzon_contactos', 'GET', `?select=id,nombre,email,telefono&buzon=eq.${enc(email)}&order=nombre.asc`);
      return json(200, (c ?? []).map((x) => ({ contactId: x.id, contactName: x.nombre, emailId: x.email, email: x.email, phone: x.telefono })));
    }
    case 'contacto_guardar': {
      const correo = limpiarEmail(p.email);
      if (!correo.includes('@')) return json(400, { error: 'email' });
      await db('buzon_contactos', 'POST', '?on_conflict=buzon,email',
        { buzon: email, email: correo, nombre: String(p.nombre ?? '').slice(0, 120), telefono: String(p.telefono ?? '').slice(0, 40) },
        'resolution=merge-duplicates,return=minimal');
      return json(200, { ok: true });
    }
    case 'contacto_borrar':
      await db('buzon_contactos', 'DELETE', `?buzon=eq.${enc(email)}&id=eq.${enc(String(p.id ?? ''))}`);
      return json(200, { ok: true });
    case 'registrar': {
      if (!p.fcm_token) return json(400, { error: 'faltan_datos' });
      const fila: Record<string, unknown> = { fcm_token: String(p.fcm_token), email, ultimo_uso: new Date().toISOString() };
      for (const k of ['avisos_correo', 'avisos_comunicados', 'avisos_actualizacion']) if (k in p) fila[k] = p[k] === true;
      if (Number.isFinite(Number(p.version_code))) fila.version_code = Number(p.version_code);
      if (typeof p.version_nombre === 'string') fila.version_nombre = p.version_nombre.slice(0, 40);
      await db('buzon_dispositivos', 'POST', '?on_conflict=fcm_token,email', fila, 'resolution=merge-duplicates,return=minimal');
      return json(200, { ok: true });
    }
    case 'baja':
      await db('buzon_dispositivos', 'DELETE', `?fcm_token=eq.${enc(String(p.fcm_token ?? ''))}&email=eq.${enc(email)}`);
      return json(200, { ok: true });
  }
  return json(400, { error: 'accion_desconocida' });
}

async function eliminarCorreos(filtro: string) {
  const correos: { id: string }[] = await db('correos', 'GET', `${filtro}&select=id`);
  if (!correos?.length) return;
  const lista = correos.map((c) => c.id).join(',');
  const adj: { ruta: string }[] = await db('correo_adjuntos', 'GET', `?select=ruta&correo_id=in.(${lista})`);
  await borrarArchivos((adj ?? []).map((a) => a.ruta));
  await db('correos', 'DELETE', `?id=in.(${lista})`);
}

async function enviar(email: string, p: Record<string, unknown>) {
  const para = emailsDe(p.para), cc = emailsDe(p.cc), cco = emailsDe(p.cco);
  if (!para.length) return json(400, { error: 'sin_destinatario', mensaje: 'Falta el destinatario.' });
  const total = para.length + cc.length + cco.length;

  // Tope diario de Resend gratis (contando destinatarios de toda la iglesia).
  const hoy = new Date(); hoy.setUTCHours(0, 0, 0, 0);
  const enviadosHoy: { para: string; cc: string; cco: string }[] = await db('correos', 'GET',
    `?select=para,cc,cco&carpeta=eq.sent&recibido_en=gte.${hoy.toISOString()}`);
  const usados = (enviadosHoy ?? []).reduce((n, c) => n + emailsDe(c.para).length + emailsDe(c.cc).length + emailsDe(c.cco).length, 0);
  if (usados + total > TOPE_DIARIO) {
    return json(429, { error: 'tope_diario', mensaje: 'Se alcanzó el límite diario de envíos de la iglesia. Probá mañana.' });
  }

  const b = await buzonActivo(email);
  const asunto = String(p.asunto ?? '').slice(0, 300);
  const html = String(p.html ?? '');
  const dominio = email.split('@')[1];
  const messageId = `<${crypto.randomUUID()}@${dominio}>`;
  // La app manda el id del correo que responde; buscamos su Message-ID real
  // para que el hilo se arme bien en Gmail, Outlook, etc.
  let inReplyTo = String(p.in_reply_to ?? '').trim();
  let refPrevias = String(p.referencias ?? '').trim();
  if (inReplyTo && !inReplyTo.startsWith('<')) {
    const orig = /^[0-9a-f-]{36}$/i.test(inReplyTo)
      ? await db('correos', 'GET', `?select=message_id,referencias&id=eq.${inReplyTo}&buzon=eq.${encodeURIComponent(email)}&limit=1`) as { message_id: string | null; referencias: string | null }[]
      : [];
    inReplyTo = orig[0]?.message_id ?? '';
    refPrevias = orig[0]?.referencias ?? refPrevias;
  }
  const referencias = [refPrevias, inReplyTo].filter(Boolean).join(' ').trim();

  const adjuntos = (Array.isArray(p.adjuntos) ? p.adjuntos : []) as { ruta: string; nombre: string; tipo?: string; tamano?: number }[];
  const propios = adjuntos.filter((a) => String(a.ruta ?? '').startsWith(`${email}/salida/`));
  const conUrl = await Promise.all(propios.map(async (a) => ({ ...a, url: await firmarDescarga(a.ruta, 600) })));

  await resend({
    from: b?.nombre ? `${b.nombre} <${email}>` : email,
    to: para, cc: cc.length ? cc : undefined, bcc: cco.length ? cco : undefined,
    subject: asunto, html,
    headers: { 'Message-ID': messageId, ...(inReplyTo ? { 'In-Reply-To': inReplyTo, References: referencias } : {}) },
    attachments: conUrl.length ? conUrl.map((a) => ({ filename: a.nombre, path: a.url })) : undefined,
  });

  const filas = await db('correos', 'POST', '', {
    buzon: email, carpeta: 'sent', message_id: messageId, in_reply_to: inReplyTo || null, referencias: referencias || null,
    de: email, de_nombre: b?.nombre ?? '', para: para.join(', '), cc: cc.join(', '), cco: cco.join(', '),
    asunto, html, resumen: textoPlano(html).slice(0, 200), leido: true, tiene_adjuntos: conUrl.length > 0,
  }, 'return=representation');
  const id = filas?.[0]?.id;
  if (id && propios.length) {
    await db('correo_adjuntos', 'POST', '', propios.map((a) => ({
      correo_id: id, nombre: a.nombre, tipo: a.tipo ?? 'application/octet-stream', tamano: a.tamano ?? 0, ruta: a.ruta,
    })), 'return=minimal');
  }
  return json(200, { ok: true, messageId: id });
}

// ─── Correo entrante (desde Cloudflare) ─────────────────────────────
async function entrante(p: Record<string, unknown>) {
  switch (p.accion) {
    // ¿A qué buzones de los destinatarios hay que entregar?
    case 'entrante_destino': {
      const doms = await dominios();
      const lista = emailsDe(Array.isArray(p.destinatarios) ? p.destinatarios.join(',') : p.destinatarios)
        .filter((e) => doms.includes(e.split('@')[1]));
      const existentes = [];
      for (const e of lista) if (await buzonActivo(e)) existentes.push(e);
      return json(200, { buzones: existentes });
    }
    // Enlaces para subir los adjuntos directo a Storage.
    case 'entrante_subir': {
      const buzon = limpiarEmail(p.buzon);
      const nombres = (Array.isArray(p.nombres) ? p.nombres : []).map((n) => String(n).replace(/[^\w.\- ]+/g, '_').slice(0, 120));
      const base = `${buzon}/entrada/${crypto.randomUUID()}`;
      const subidas = await Promise.all(nombres.map(async (n, i) => {
        const ruta = `${base}/${i}_${n}`;
        return { ruta, url: await firmarSubida(ruta) };
      }));
      return json(200, { subidas });
    }
    case 'entrante': {
      const buzon = limpiarEmail(p.buzon);
      if (!(await buzonActivo(buzon))) return json(404, { error: 'buzon' });
      const mid = String(p.message_id ?? '').trim();
      if (mid) {
        const ya = await db('correos', 'GET', `?select=id&buzon=eq.${enc(buzon)}&message_id=eq.${enc(mid)}&carpeta=neq.sent`);
        if (ya?.length) return json(200, { ok: true, duplicado: true });
      }
      const html = String(p.html ?? '');
      const texto = String(p.texto ?? '');
      const adjuntos = (Array.isArray(p.adjuntos) ? p.adjuntos : []) as Record<string, unknown>[];
      const correo = {
        buzon, carpeta: p.spam === true ? 'spam' : 'inbox',
        message_id: mid || null, in_reply_to: String(p.in_reply_to ?? '') || null, referencias: String(p.referencias ?? '') || null,
        de: limpiarEmail(p.de), de_nombre: String(p.de_nombre ?? '').slice(0, 200),
        para: String(p.para ?? '').slice(0, 2000), cc: String(p.cc ?? '').slice(0, 2000),
        responder_a: String(p.responder_a ?? '').slice(0, 300),
        asunto: String(p.asunto ?? '').slice(0, 500),
        html: html.slice(0, 2_000_000), texto: texto.slice(0, 500_000),
        resumen: (textoPlano(html) || texto.replace(/\s+/g, ' ')).slice(0, 200),
        tiene_adjuntos: adjuntos.some((a) => !a.cid), tamano: Number(p.tamano) || 0,
        recibido_en: p.fecha ? new Date(String(p.fecha)).toISOString() : new Date().toISOString(),
      };
      if (Number.isNaN(new Date(correo.recibido_en).getTime())) correo.recibido_en = new Date().toISOString();
      const filas = await db('correos', 'POST', '', correo, 'return=representation');
      const c = filas[0];
      if (adjuntos.length) {
        await db('correo_adjuntos', 'POST', '', adjuntos.map((a) => ({
          correo_id: c.id, nombre: String(a.nombre ?? 'adjunto').slice(0, 200), tipo: String(a.tipo ?? 'application/octet-stream'),
          tamano: Number(a.tamano) || 0, cid: a.cid ? String(a.cid).replace(/[<>]/g, '') : null, ruta: String(a.ruta),
        })), 'return=minimal');
      }
      if (correo.carpeta === 'inbox') await avisarCorreoNuevo(buzon, c);
      return json(200, { ok: true, id: c.id });
    }
  }
  return json(400, { error: 'accion_desconocida' });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'metodo' });
  // deno-lint-ignore no-explicit-any
  let p: Record<string, any>;
  try { p = await req.json(); } catch { return json(400, { error: 'json' }); }
  try {
    if (String(p.accion ?? '').startsWith('entrante')) {
      const s = req.headers.get('x-buzon-secreto') ?? '';
      if (!env('BUZON_SECRETO') || s !== env('BUZON_SECRETO')) return json(401, { error: 'no_autorizado' });
      return await entrante(p);
    }
    if (p.accion === 'clave_temporal' || p.accion === 'eliminar_buzon') {
      if (!(await esSuperadmin(req))) return json(403, { error: 'solo_superadmin' });
      return await panel(p);
    }
    const libre = await sinSesion(p);
    if (libre) return libre;
    const email = await quien(p);
    if (!email) return json(401, { error: 'sesion_vencida' });
    return await conSesion(email, p);
  } catch (e) {
    console.error(e);
    return json(500, { error: 'interno', mensaje: String(e).slice(0, 300) });
  }
});
