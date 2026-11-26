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
const CANAL_AVISOS = 'pieba_avisos_channel';

const env = (k: string) => Deno.env.get(k) ?? '';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ─── Base de datos (REST con la clave de servicio) ──────────────
async function db(method: string, query: string, body?: unknown, prefer?: string) {
  return dbt(TABLA, method, query, body, prefer);
}
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

// ─── Acciones ──────────────────────────────────────────────────
async function registrar(p: Record<string, string>) {
  if (!p.fcm_token || !p.refresh_token) return json(400, { error: 'faltan_datos' });

  // 1. El refresh token se renueva: eso prueba que la sesión es válida
  let nuevo;
  try { nuevo = await refrescarToken(p.refresh_token); } catch { return json(401, { error: 'refresh_invalido' }); }
  const cuenta = await cuentaDelToken(nuevo.token);
  if (!cuenta) return json(401, { error: 'token_invalido' });
  if (!cuenta.email.endsWith(`@${DOMINIO_PERMITIDO}`)) return json(403, { error: 'dominio_no_permitido' });

  // 2. Si mandó también el access token (vigente), tiene que ser de la misma cuenta
  const cuenta1 = p.access_token ? await cuentaDelToken(p.access_token) : null;
  if (cuenta1 && cuenta1.email !== cuenta.email) return json(403, { error: 'cuentas_distintas' });

  // 3. Bandeja de entrada y punto de partida (no avisar correos viejos)
  const inbox = await carpetaEntrada(cuenta.host, cuenta.accountId, nuevo.token);
  if (!inbox) return json(502, { error: 'sin_bandeja' });
  const ultimos = await ultimosCorreos(cuenta.host, cuenta.accountId, inbox, nuevo.token, 1);
  const base = Math.max(0, ...ultimos.map((m: Record<string, unknown>) => Number(m.receivedTime) || 0));

  await db('POST', '?on_conflict=fcm_token,email', {
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
    ultimo_uso: new Date().toISOString(),
    ...versionYPreferencias(p),
  }, 'resolution=merge-duplicates,return=minimal');

  return json(200, { ok: true, email: cuenta.email });
}

// Con "email": deja de avisar esa cuenta en ese teléfono. Sin email: todas.
async function baja(p: Record<string, string>) {
  if (!p.fcm_token) return json(400, { error: 'faltan_datos' });
  const filtroEmail = p.email ? `&email=eq.${encodeURIComponent(String(p.email).toLowerCase())}` : '';
  await db('DELETE', `?fcm_token=eq.${encodeURIComponent(p.fcm_token)}${filtroEmail}`);
  return json(200, { ok: true });
}

type Dispositivo = {
  fcm_token: string; email: string; account_id: string; api_host: string; inbox_folder_id: string;
  refresh_token_cifrado: string; access_token_cifrado: string | null; access_token_expira: string | null;
  ultimo_recibido: number; errores_seguidos: number; avisos_correo?: boolean;
};

async function revisarDispositivo(d: Dispositivo, variasCuentas = false) {
  const filtro = `?fcm_token=eq.${encodeURIComponent(d.fcm_token)}&email=eq.${encodeURIComponent(d.email)}`;
  // Con varias cuentas en el teléfono, el aviso dice a cuál llegó.
  const para = variasCuentas ? ` · para ${d.email.split('@')[0]}` : '';
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
    if (d.avisos_correo === false) {
      // Avisos de correo apagados en este teléfono: solo avanzar el punto de partida.
    } else if (nuevos.length > 3) {
      const r = await enviarPush(d.fcm_token, `${nuevos.length} correos nuevos${para}`, nuevos.slice(-3).map((m: Record<string, unknown>) => m.sender || m.fromAddress).join(', '), { tipo: 'varios', email: d.email });
      if (r === 'token_invalido') { await db('DELETE', filtro); return { email: d.email, baja: true }; }
      enviados = 1;
    } else {
      for (const m of nuevos) {
        const r = await enviarPush(
          d.fcm_token,
          String(m.sender || m.fromAddress || 'Nuevo correo'),
          String(m.subject || '(Sin asunto)') + para,
          { tipo: 'correo', messageId: String(m.messageId), folderId: String(m.folderId ?? d.inbox_folder_id), email: d.email },
        );
        if (r === 'token_invalido') { await db('DELETE', `?fcm_token=eq.${encodeURIComponent(d.fcm_token)}`); return { email: d.email, baja: true }; }
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
  const porTelefono = new Map<string, number>();
  for (const d of dispositivos) porTelefono.set(d.fcm_token, (porTelefono.get(d.fcm_token) ?? 0) + 1);
  const resultados = [];
  // De a 5 en paralelo para no saturar a Zoho
  for (let i = 0; i < dispositivos.length; i += 5) {
    const lote = await Promise.allSettled(dispositivos.slice(i, i + 5).map((d) => revisarDispositivo(d, (porTelefono.get(d.fcm_token) ?? 0) > 1)));
    for (const r of lote) resultados.push(r.status === 'fulfilled' ? r.value : { error: String(r.reason) });
  }
  const comunicados = await enviarComunicados().catch((e) => ({ error: String(e) }));
  return json(200, { revisados: dispositivos.length, resultados, comunicados });
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

// Quién es (por su access token de Zoho). Cache corto para no consultar a Zoho en cada llamada.
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
  if (!token) return null;
  const c = cacheCuentas.get(token);
  if (c && c.hasta > Date.now()) return c.email;
  if (token.split('.').length === 3) {
    const e = await emailDeSesionPropia(token);
    if (!e) return null;
    cacheCuentas.set(token, { email: e, hasta: Date.now() + 5 * 60_000 });
    return e;
  }
  const cuenta = await cuentaDelToken(token);
  if (!cuenta || !cuenta.email.endsWith(DOMINIO_PERMITIDO)) return null;
  if (cacheCuentas.size > 500) cacheCuentas.clear();
  cacheCuentas.set(token, { email: cuenta.email, hasta: Date.now() + 5 * 60_000 });
  return cuenta.email;
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
        await db('PATCH', `?fcm_token=eq.${encodeURIComponent(p.fcm_token)}&email=eq.${encodeURIComponent(email)}`,
          { ultimo_uso: new Date().toISOString(), ...versionYPreferencias({ version_code: p.version_code, version_nombre: p.version_nombre }) },
          'return=minimal');
      }
      const [admin, config, comunicados] = await Promise.all([esAdminApp(email), configApp(), comunicadosDe(email, version, 20)]);
      return json(200, { email, es_admin: admin, config, comunicados_pendientes: comunicados.filter((c) => !c.visto) });
    }
    case 'preferencias': {
      if (typeof p.fcm_token !== 'string' || !p.fcm_token) return json(400, { error: 'faltan_datos' });
      await db('PATCH', `?fcm_token=eq.${encodeURIComponent(p.fcm_token)}&email=eq.${encodeURIComponent(email)}`,
        versionYPreferencias(p), 'return=minimal');
      await dbt('buzon_dispositivos', 'PATCH', `?fcm_token=eq.${encodeURIComponent(p.fcm_token)}&email=eq.${encodeURIComponent(email)}`,
        versionYPreferencias(p), 'return=minimal').catch(() => {});
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
      const dispositivos = [
        ...((await db('GET',
          '?select=email,version_code,version_nombre,ultimo_uso,errores_seguidos,ultimo_error,avisos_correo,avisos_comunicados,actualizado_en&order=email.asc')) ?? []),
        ...((await dbt('buzon_dispositivos', 'GET',
          '?select=email,version_code,version_nombre,ultimo_uso,avisos_correo,avisos_comunicados&order=email.asc').catch(() => [])) ?? []),
      ];
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
    [
      ...((await db('GET', '?select=fcm_token,email,version_code,avisos_comunicados,avisos_actualizacion')) ?? []),
      ...((await dbt('buzon_dispositivos', 'GET', '?select=fcm_token,email,version_code,avisos_comunicados,avisos_actualizacion').catch(() => [])) ?? []),
    ];

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
          await db('DELETE', `?fcm_token=eq.${encodeURIComponent(d.fcm_token)}`);
          await dbt('buzon_dispositivos', 'DELETE', `?fcm_token=eq.${encodeURIComponent(d.fcm_token)}`).catch(() => {});
        } else enviados++;
      } catch (e) { console.error('comunicado', c.id, e); }
    }
    await dbt('mail_comunicados', 'PATCH', `?id=eq.${c.id}`, { enviados }, 'return=minimal');
    resumen.push({ id: c.id, enviados });
  }
  return resumen;
}


// ─── Migración única: Zoho → correo propio (solo superadmin del panel) ─────
// El panel llama repetidas veces con el "cursor" que devuelve la anterior,
// hasta que responde terminado=true. Cada llamada copia hasta 15 correos.
async function esSuperadminPanel(req: Request) {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/es_superadmin`, {
    method: 'POST',
    headers: { apikey: env('SUPABASE_ANON_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: auth, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return r.ok && (await r.json()) === true;
}

const CARPETA_ZOHO: Record<string, string> = {
  inbox: 'inbox', sent: 'sent', drafts: 'drafts', spam: 'spam', trash: 'trash',
};
const desHtml = (t: unknown) => String(t ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const soloEmails = (t: unknown) =>
  (desHtml(t).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase()).join(', ');
const tipoArchivo = (n: string) => {
  const x = n.toLowerCase().split('.').pop() ?? '';
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain', zip: 'application/zip' } as Record<string, string>)[x] ?? 'application/octet-stream';
};

async function zohoBinario(host: string, path: string, token: string) {
  const res = await fetch(`https://${host}${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (!res.ok) throw new Error(`Zoho ${path} HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function migrarZoho(p: Record<string, unknown>) {
  const email = String(p.email ?? '').trim().toLowerCase();
  // Cuentas con permiso de Zoho guardado (las que entraron alguna vez a la app).
  if (p.listar === true) {
    const filas: { email: string }[] = (await db('GET', '?select=email')) ?? [];
    const buzones: { email: string }[] = (await dbt('buzones', 'GET', '?select=email')) ?? [];
    const conBuzon = new Set(buzones.map((b) => b.email));
    const unicos = [...new Set(filas.map((f) => f.email))].sort();
    return json(200, { cuentas: unicos.map((e) => ({ email: e, tiene_buzon: conBuzon.has(e) })) });
  }
  if (!email) return json(400, { error: 'falta_email' });
  const b = await dbt('buzones', 'GET', `?select=email&email=eq.${encodeURIComponent(email)}`);
  if (!b?.length) return json(400, { error: 'sin_buzon', mensaje: 'Primero creá el buzón con esa dirección.' });

  const disp: Dispositivo[] = await db('GET', `?email=eq.${encodeURIComponent(email)}&order=actualizado_en.desc&limit=5`);
  if (!disp?.length) return json(404, { error: 'sin_permiso', mensaje: 'Esa cuenta nunca entró a la app con Zoho.' });
  let token = '';
  for (const d of disp) {
    try { token = (await refrescarToken(await descifrar(d.refresh_token_cifrado))).token; break; } catch { /* probar otro */ }
  }
  if (!token) return json(409, { error: 'permiso_vencido', mensaje: 'Zoho ya no acepta el permiso guardado de esa cuenta.' });
  const cuenta = await cuentaDelToken(token);
  if (!cuenta) return json(502, { error: 'zoho', mensaje: 'Zoho no respondió.' });
  const { host, accountId } = cuenta;

  const carpetas = ((await zohoGet(host, `/api/accounts/${accountId}/folders`, token)) ?? [])
    .map((f: Record<string, unknown>) => {
      const tipo = String(f.folderType ?? '').toLowerCase();
      if (['outbox', 'templates', 'snoozed'].includes(tipo)) return null;
      return { id: String(f.folderId), nombre: String(f.folderName ?? tipo), destino: CARPETA_ZOHO[tipo] ?? 'archive' };
    })
    .filter(Boolean) as { id: string; nombre: string; destino: string }[];

  let idx = Math.max(0, Number(p.carpeta_idx) || 0);
  let start = Math.max(1, Number(p.start) || 1);
  const LOTE = 15;
  let copiados = 0, repetidos = 0, errores = 0;

  while (idx < carpetas.length) {
    const c = carpetas[idx];
    const q = new URLSearchParams({ folderId: c.id, start: String(start), limit: String(LOTE), includeto: 'true' });
    const lista: Record<string, unknown>[] = (await zohoGet(host, `/api/accounts/${accountId}/messages/view?${q}`, token)) ?? [];
    if (!lista.length) { idx++; start = 1; continue; }

    for (const m of lista) {
      const mid = `<zoho-${m.messageId}@${DOMINIO_PERMITIDO}>`;
      try {
        const ya = await dbt('correos', 'GET', `?select=id&buzon=eq.${encodeURIComponent(email)}&message_id=eq.${encodeURIComponent(mid)}`);
        if (ya?.length) { repetidos++; continue; }
        const base = `/api/accounts/${accountId}/folders/${c.id}/messages/${m.messageId}`;
        const contenido = await zohoGet(host, `${base}/content`, token).catch(() => null);
        const html = String(contenido?.content ?? '');
        const texto = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        const recibido = Number(m.receivedTime ?? m.sentDateInGMT);
        const fila = {
          buzon: email, carpeta: c.destino, message_id: mid,
          de: soloEmails(m.fromAddress).split(', ')[0] ?? '', de_nombre: desHtml(m.sender ?? '').slice(0, 200),
          para: soloEmails(m.toAddress).slice(0, 2000), cc: soloEmails(m.ccAddress).slice(0, 2000),
          asunto: desHtml(m.subject ?? '').slice(0, 500), html: html.slice(0, 2_000_000), texto: texto.slice(0, 500_000),
          resumen: (desHtml(m.summary ?? '') || texto).slice(0, 200),
          leido: String(m.status ?? '') === '1' || c.destino === 'sent' || c.destino === 'drafts',
          tiene_adjuntos: String(m.hasAttachment ?? '0') === '1', tamano: Number(m.size) || 0,
          recibido_en: Number.isFinite(recibido) && recibido > 0 ? new Date(recibido).toISOString() : new Date().toISOString(),
        };
        const [nuevo] = await dbt('correos', 'POST', '', fila, 'return=representation');

        if (fila.tiene_adjuntos) {
          const info = await zohoGet(host, `${base}/attachmentinfo`, token).catch(() => null);
          const adj: Record<string, unknown>[] = [...(info?.attachments ?? []), ...(info?.inline ?? [])];
          const filasAdj = [];
          for (const a of adj) {
            const nombre = String(a.attachmentName ?? 'adjunto').replace(/[\\/]/g, '_').slice(0, 150);
            try {
              const bytes = await zohoBinario(host, `${base}/attachments/${a.attachmentId}`, token);
              const ruta = `${email}/zoho/${crypto.randomUUID()}/${nombre}`;
              const up = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/correo/${ruta.split('/').map(encodeURIComponent).join('/')}`, {
                method: 'POST',
                headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
                  'Content-Type': tipoArchivo(nombre), 'x-upsert': 'true' },
                body: bytes,
              });
              if (!up.ok) throw new Error(`storage ${up.status}`);
              filasAdj.push({ correo_id: nuevo.id, nombre, tipo: tipoArchivo(nombre), tamano: bytes.length,
                cid: a.cid ? String(a.cid).replace(/[<>]/g, '') : null, ruta });
            } catch (e) { console.error('adjunto', nombre, e); errores++; }
          }
          if (filasAdj.length) await dbt('correo_adjuntos', 'POST', '', filasAdj, 'return=minimal');
        }
        copiados++;
      } catch (e) { console.error('migrar', m.messageId, e); errores++; }
    }
    start += lista.length;
    if (lista.length < LOTE) { idx++; start = 1; }
    break; // un lote por llamada: así nunca se pasa del tiempo límite
  }

  const terminado = idx >= carpetas.length;
  return json(200, {
    terminado, copiados, repetidos, errores,
    carpeta: terminado ? null : carpetas[idx]?.nombre, carpeta_idx: idx, start, total_carpetas: carpetas.length,
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  // deno-lint-ignore no-explicit-any
  let p: Record<string, any>;
  try { p = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  try {
    if (p.accion === 'revisar') {
      if (!env('MAIL_CRON_SECRET') || req.headers.get('x-cron-secret') !== env('MAIL_CRON_SECRET')) return json(401, { error: 'no_autorizado' });
      return await revisar();
    }
    if (p.accion === 'migrar_zoho') {
      if (!(await esSuperadminPanel(req))) return json(403, { error: 'solo_superadmin' });
      return await migrarZoho(p);
    }
    if (p.accion === 'registrar') return await registrar(p);
    if (p.accion === 'baja') return await baja(p);
    return await accionApp(p);
  } catch (e) {
    console.error(e);
    return json(500, { error: 'error_interno' });
  }
});
