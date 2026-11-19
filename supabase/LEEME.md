# Supabase · PIEBA

## Qué hay acá

| Archivo | Para qué |
|---|---|
| `migrations/20261119120000_esquema_inicial.sql` | Tablas, seguridad (RLS), lista de correos permitidos y funciones del login |
| `templates/confirm-signup.html` | Correo del primer ingreso (código para crear la contraseña) |
| `templates/magic-link.html` | Correo de "olvidé mi contraseña" |

## Configuración en el Dashboard (una sola vez)

1. **Primer administrador.** En *SQL Editor*:
   ```sql
   insert into public.usuarios_permitidos (email, nombre) values ('tu@correo.com', 'Tu nombre');
   ```
   Los demás se agregan desde el panel → *Usuarios*.

2. **Hook que bloquea correos no autorizados.** *Authentication → Hooks → Before User Created* →
   tipo *Postgres*, esquema `public`, función `hook_solo_correos_permitidos` → activar.

3. **Código por correo.** *Authentication → Sign In / Providers → Email*:
   - Email OTP Length: `8` (o `6`)
   - Email OTP Expiration: `600` segundos (10 minutos)
   - Confirm email: activado

4. **Plantillas de correo.** *Authentication → Emails → Templates*:
   - **Confirm signup** → `templates/confirm-signup.html` · asunto `Tu código de acceso · PIEBA`
   - **Magic Link** → `templates/magic-link.html` · asunto `Recuperá tu contraseña · PIEBA`

5. **Servidor de correo propio (SMTP).** *Authentication → Emails → SMTP Settings*: datos de Resend o Brevo,
   remitente `no-responder@<dominio-de-la-iglesia>`. Sin esto los códigos llegan con un límite muy bajo por hora.

6. **URL del sitio.** *Authentication → URL Configuration*: Site URL = la dirección pública de la web.

## Vercel

Variables de entorno: se pueden **borrar** `FIREBASE_SERVICE_ACCOUNT`. Se mantienen `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET`.

## Migrar los datos de Firestore

Ver instrucciones al inicio de `scripts/migracion/migrar-firestore.mjs`.
