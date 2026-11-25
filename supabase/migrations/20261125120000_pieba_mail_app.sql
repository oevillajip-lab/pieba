-- ════════════════════════════════════════════════════════════════
--  PIEBA Mail · Roles, plantillas, comunicados y configuración remota
-- ════════════════════════════════════════════════════════════════
--  · Web: "superadmin" en usuarios_permitidos (ozkrv1@gmail.com). Solo
--    el superadmin ve y maneja la sección "PIEBA Mail" del panel.
--  · App: mail_admins = correos @primeradeasuncion.org.py que ven el
--    registro de errores y la configuración del servidor en la app.
--  · La app nunca toca estas tablas directo: pasa por la función
--    mail-push (que verifica con Zoho quién es la persona).
-- ════════════════════════════════════════════════════════════════

-- ─── Superadmin del panel web ──────────────────────────────────
alter table public.usuarios_permitidos
  add column if not exists superadmin boolean not null default false;

update public.usuarios_permitidos set superadmin = true where email = 'ozkrv1@gmail.com';

create or replace function public.es_superadmin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.usuarios_permitidos p
    where p.superadmin
      and p.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke execute on function public.es_superadmin() from public;
grant  execute on function public.es_superadmin() to anon, authenticated;

-- Solo un superadmin puede dar o quitar "superadmin" (un admin común no
-- puede ascenderse a sí mismo). El SQL Editor (sin sesión) sí puede.
create or replace function public.proteger_superadmin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.superadmin and not public.es_superadmin() then
      new.superadmin := false;
    end if;
  elsif new.superadmin is distinct from old.superadmin and not public.es_superadmin() then
    new.superadmin := old.superadmin;
  end if;
  return new;
end;
$$;

drop trigger if exists usuarios_permitidos_superadmin on public.usuarios_permitidos;
create trigger usuarios_permitidos_superadmin
  before insert or update on public.usuarios_permitidos
  for each row execute function public.proteger_superadmin();

drop function if exists public.listar_usuarios();
create function public.listar_usuarios()
returns table (email text, nombre text, creado_en timestamptz, creado_por text,
               activo boolean, ultimo_ingreso timestamptz, superadmin boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.es_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select p.email, p.nombre, p.creado_en, p.creado_por,
           (p.password_creada and u.id is not null) as activo,
           u.last_sign_in_at as ultimo_ingreso,
           p.superadmin
    from public.usuarios_permitidos p
    left join auth.users u on lower(u.email) = p.email
    order by p.creado_en;
end;
$$;
revoke execute on function public.listar_usuarios() from public;
grant  execute on function public.listar_usuarios() to authenticated;


-- ─── Administradores de la app ─────────────────────────────────
create table if not exists public.mail_admins (
  email      text primary key
             check (email = lower(btrim(email)) and email like '%@primeradeasuncion.org.py'),
  creado_en  timestamptz not null default now()
);
insert into public.mail_admins (email) values ('soporte@primeradeasuncion.org.py')
  on conflict do nothing;


-- ─── Dispositivos: versión instalada y preferencias de aviso ───
alter table public.mail_dispositivos
  add column if not exists version_code         integer,
  add column if not exists version_nombre       text,
  add column if not exists ultimo_uso           timestamptz,
  add column if not exists avisos_correo        boolean not null default true,
  add column if not exists avisos_comunicados   boolean not null default true,
  add column if not exists avisos_actualizacion boolean not null default true;


-- ─── Plantillas de cada usuario ────────────────────────────────
create table if not exists public.mail_plantillas (
  id              text not null,
  email           text not null check (email like '%@primeradeasuncion.org.py'),
  nombre          text not null default '',
  asunto          text not null default '',
  cuerpo          text not null default '',
  borrada         boolean not null default false,
  actualizado_en  timestamptz not null default now(),
  primary key (email, id)
);


-- ─── Comunicados (push + cartel en la app) ─────────────────────
create table if not exists public.mail_comunicados (
  id               uuid primary key default gen_random_uuid(),
  tipo             text not null default 'aviso'
                   check (tipo in ('actualizacion', 'aviso', 'problemas', 'saludos')),
  titulo           text not null,
  contenido        text not null default '',   -- HTML del editor
  imagen_url       text,
  destino          text not null default 'todos'
                   check (destino in ('todos', 'usuarios', 'version_vieja', 'version_nueva')),
  destino_emails   text[],
  version_code     integer,
  programado_para  timestamptz not null default now(),
  enviado_en       timestamptz,
  enviados         integer not null default 0,
  activo           boolean not null default true,
  creado_por       text,
  creado_en        timestamptz not null default now()
);
create index if not exists mail_comunicados_pendientes
  on public.mail_comunicados (programado_para) where enviado_en is null;

create table if not exists public.mail_comunicados_vistos (
  comunicado_id  uuid not null references public.mail_comunicados (id) on delete cascade,
  email          text not null,
  visto_en       timestamptz not null default now(),
  primary key (comunicado_id, email)
);


-- ─── Configuración remota de la app ────────────────────────────
create table if not exists public.mail_config (
  clave           text primary key,
  valor           jsonb not null,
  actualizado_en  timestamptz not null default now()
);
insert into public.mail_config (clave, valor) values
  ('colores', '{}'::jsonb),
  ('textos', '{"aviso_general": ""}'::jsonb),
  ('menu', '["inbox", "sent", "spam", "trash", "archive"]'::jsonb),
  ('funciones', '{"plantillas": true, "contactos": true}'::jsonb),
  ('version', '{"version_code": 0, "obligatoria": false, "notas": ""}'::jsonb)
on conflict (clave) do nothing;


-- ─── Seguridad ─────────────────────────────────────────────────
alter table public.mail_admins             enable row level security;
alter table public.mail_plantillas         enable row level security;
alter table public.mail_comunicados        enable row level security;
alter table public.mail_comunicados_vistos enable row level security;
alter table public.mail_config             enable row level security;

-- Panel web: solo el superadmin. Las plantillas no las ve nadie desde la web.
drop policy if exists "Superadmin" on public.mail_admins;
create policy "Superadmin" on public.mail_admins for all to authenticated
  using (public.es_superadmin()) with check (public.es_superadmin());
drop policy if exists "Superadmin" on public.mail_comunicados;
create policy "Superadmin" on public.mail_comunicados for all to authenticated
  using (public.es_superadmin()) with check (public.es_superadmin());
drop policy if exists "Superadmin lee" on public.mail_comunicados_vistos;
create policy "Superadmin lee" on public.mail_comunicados_vistos for select to authenticated
  using (public.es_superadmin());
drop policy if exists "Superadmin" on public.mail_config;
create policy "Superadmin" on public.mail_config for all to authenticated
  using (public.es_superadmin()) with check (public.es_superadmin());

-- Lista de teléfonos con la app (sin tokens) para el panel.
create or replace function public.mail_listar_dispositivos()
returns table (email text, version_code integer, version_nombre text,
               ultimo_uso timestamptz, avisos_correo boolean,
               avisos_comunicados boolean, es_admin boolean)
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
    select d.email, max(d.version_code), max(d.version_nombre),
           max(coalesce(d.ultimo_uso, d.actualizado_en)),
           bool_or(d.avisos_correo), bool_or(d.avisos_comunicados),
           exists (select 1 from public.mail_admins a where a.email = d.email)
    from public.mail_dispositivos d
    group by d.email
    order by d.email;
end;
$$;
revoke execute on function public.mail_listar_dispositivos() from public;
grant  execute on function public.mail_listar_dispositivos() to authenticated;

revoke all on public.mail_plantillas, public.mail_comunicados_vistos from anon, authenticated;
revoke all on public.mail_admins, public.mail_comunicados, public.mail_config from anon;
grant select, insert, update, delete on public.mail_admins, public.mail_comunicados, public.mail_config
  to authenticated;
grant select on public.mail_comunicados_vistos to authenticated;
grant all on public.mail_admins, public.mail_plantillas, public.mail_comunicados,
             public.mail_comunicados_vistos, public.mail_config to service_role;
