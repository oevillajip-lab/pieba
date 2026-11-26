-- ════════════════════════════════════════════════════════════════
--  PIEBA Mail · Correo propio (sin Zoho)
-- ════════════════════════════════════════════════════════════════
--  Recibir: Cloudflare Email Routing → función buzon-entrante.
--  Enviar:  Resend (dominio ya verificado).
--  Guardar: estas tablas + Storage (adjuntos).
--  La app nunca toca estas tablas directo: pasa por la función "buzon"
--  (a través de la web), que valida la sesión de la persona.
-- ════════════════════════════════════════════════════════════════

-- Dominios que reciben correo (el real y uno de prueba para ensayar).
create table if not exists public.buzon_dominios (
  dominio   text primary key check (dominio = lower(btrim(dominio))),
  creado_en timestamptz not null default now()
);
insert into public.buzon_dominios (dominio) values
  ('primeradeasuncion.org.py'),
  ('prueba.primeradeasuncion.org.py')
on conflict do nothing;

-- Cuentas de correo.
create table if not exists public.buzones (
  email            text primary key check (email = lower(btrim(email)) and email like '%@%'),
  nombre           text not null default '',
  correo_personal  text check (correo_personal is null or correo_personal like '%@%'),
  activo           boolean not null default true,
  creado_en        timestamptz not null default now(),
  creado_por       text
);

-- PIN de primer ingreso / olvido de contraseña (se guarda solo el hash).
create table if not exists public.buzon_pines (
  email       text primary key references public.buzones (email) on delete cascade,
  pin_hash    text not null,
  expira_en   timestamptz not null,
  intentos    integer not null default 0,
  creado_en   timestamptz not null default now()
);

-- Correos.
create table if not exists public.correos (
  id              uuid primary key default gen_random_uuid(),
  buzon           text not null references public.buzones (email) on delete cascade,
  carpeta         text not null default 'inbox'
                  check (carpeta in ('inbox', 'sent', 'drafts', 'spam', 'trash', 'archive')),
  message_id      text,            -- encabezado Message-ID (para hilos)
  in_reply_to     text,
  referencias     text,
  de              text not null default '',
  de_nombre       text not null default '',
  para            text not null default '',
  cc              text not null default '',
  cco             text not null default '',
  responder_a     text not null default '',
  asunto          text not null default '',
  resumen         text not null default '',
  html            text not null default '',
  texto           text not null default '',
  leido           boolean not null default false,
  tiene_adjuntos  boolean not null default false,
  tamano          integer not null default 0,
  recibido_en     timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index if not exists correos_buzon_carpeta on public.correos (buzon, carpeta, recibido_en desc);
create index if not exists correos_message_id on public.correos (buzon, message_id);

create table if not exists public.correo_adjuntos (
  id          uuid primary key default gen_random_uuid(),
  correo_id   uuid not null references public.correos (id) on delete cascade,
  nombre      text not null default 'adjunto',
  tipo        text not null default 'application/octet-stream',
  tamano      integer not null default 0,
  cid         text,
  ruta        text not null,          -- ruta en Storage (bucket "correo")
  creado_en   timestamptz not null default now()
);
create index if not exists correo_adjuntos_correo on public.correo_adjuntos (correo_id);

create table if not exists public.buzon_contactos (
  id          uuid primary key default gen_random_uuid(),
  buzon       text not null references public.buzones (email) on delete cascade,
  nombre      text not null default '',
  email       text not null,
  telefono    text not null default '',
  creado_en   timestamptz not null default now(),
  unique (buzon, email)
);

-- Teléfonos con la app (avisos al instante). Una fila por teléfono + cuenta.
create table if not exists public.buzon_dispositivos (
  fcm_token             text not null,
  email                 text not null references public.buzones (email) on delete cascade,
  version_code          integer,
  version_nombre        text,
  avisos_correo         boolean not null default true,
  avisos_comunicados    boolean not null default true,
  avisos_actualizacion  boolean not null default true,
  ultimo_uso            timestamptz not null default now(),
  primary key (fcm_token, email)
);

-- Las cuentas de correo también pueden iniciar sesión (además de las del
-- panel). El panel sigue siendo solo para usuarios_permitidos (es_admin).
create or replace function public.hook_solo_correos_permitidos(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if exists (select 1 from public.usuarios_permitidos where email = v_email)
     or exists (select 1 from public.buzones where email = v_email and activo) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object('http_code', 403, 'message', 'Este correo no tiene acceso.'));
end;
$$;
revoke execute on function public.hook_solo_correos_permitidos(jsonb) from public, anon, authenticated;
grant  execute on function public.hook_solo_correos_permitidos(jsonb) to supabase_auth_admin;
grant select on public.buzones to supabase_auth_admin;

-- Lista de buzones para el panel (con uso).
create or replace function public.listar_buzones()
returns table (email text, nombre text, correo_personal text, activo boolean,
               creado_en timestamptz, ultimo_ingreso timestamptz, correos bigint,
               dispositivos bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.es_superadmin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select b.email, b.nombre, b.correo_personal, b.activo, b.creado_en,
           u.last_sign_in_at,
           (select count(*) from public.correos c where c.buzon = b.email),
           (select count(*) from public.buzon_dispositivos d where d.email = b.email)
    from public.buzones b
    left join auth.users u on lower(u.email) = b.email
    order by b.email;
end;
$$;
revoke execute on function public.listar_buzones() from public;
grant  execute on function public.listar_buzones() to authenticated;

-- Seguridad: nadie de afuera lee estas tablas; el panel solo administra
-- buzones y dominios (superadmin). Todo lo demás pasa por las funciones.
alter table public.buzon_dominios     enable row level security;
alter table public.buzones            enable row level security;
alter table public.buzon_pines        enable row level security;
alter table public.correos            enable row level security;
alter table public.correo_adjuntos    enable row level security;
alter table public.buzon_contactos    enable row level security;
alter table public.buzon_dispositivos enable row level security;

drop policy if exists "Superadmin" on public.buzones;
create policy "Superadmin" on public.buzones for all to authenticated
  using (public.es_superadmin()) with check (public.es_superadmin());
drop policy if exists "Superadmin" on public.buzon_dominios;
create policy "Superadmin" on public.buzon_dominios for all to authenticated
  using (public.es_superadmin()) with check (public.es_superadmin());

revoke all on public.buzon_pines, public.correos, public.correo_adjuntos,
              public.buzon_contactos, public.buzon_dispositivos from anon, authenticated;
revoke all on public.buzones, public.buzon_dominios from anon;
grant select, insert, update, delete on public.buzones, public.buzon_dominios to authenticated;
grant all on public.buzon_dominios, public.buzones, public.buzon_pines, public.correos,
             public.correo_adjuntos, public.buzon_contactos, public.buzon_dispositivos
  to service_role;

-- Adjuntos: bucket privado (solo las funciones, con enlaces firmados).
insert into storage.buckets (id, name, public, file_size_limit)
values ('correo', 'correo', false, 26214400)
on conflict (id) do nothing;

-- Id de la cuenta de inicio de sesión de un buzón (solo para la función).
create or replace function public.buzon_user_id(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(btrim(p_email)) limit 1;
$$;
revoke execute on function public.buzon_user_id(text) from public, anon, authenticated;
grant  execute on function public.buzon_user_id(text) to service_role;

-- Plantillas y administradores de la app: aceptar también el dominio de prueba.
alter table public.mail_plantillas drop constraint if exists mail_plantillas_email_check;
alter table public.mail_plantillas add constraint mail_plantillas_email_check
  check (email like '%primeradeasuncion.org.py');
alter table public.mail_admins drop constraint if exists mail_admins_email_check;
alter table public.mail_admins add constraint mail_admins_email_check
  check (email = lower(btrim(email)) and email like '%primeradeasuncion.org.py');
