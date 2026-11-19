-- ════════════════════════════════════════════════════════════════
--  PIEBA · Esquema inicial (migración desde Firebase/Firestore)
-- ════════════════════════════════════════════════════════════════
--  Tablas de contenido: avisos, eventos, galeria, blog, miembros
--  Configuración de la web: web_config (una sola fila)
--  Acceso al panel: usuarios_permitidos (lista de correos admitidos)
--
--  Seguridad:
--   · Todo el contenido se puede LEER públicamente.
--   · Solo los usuarios logueados cuyo correo está en
--     usuarios_permitidos pueden crear, editar o borrar.
--   · Un hook de Auth impide que se cree una cuenta con un correo
--     que no esté en la lista (hay que activarlo en el Dashboard:
--     Authentication → Hooks → Before User Created →
--     public.hook_solo_correos_permitidos).
-- ════════════════════════════════════════════════════════════════


-- ─── Utilidad: mantener actualizado_en ─────────────────────────
create or replace function public.tocar_actualizado_en()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;


-- ════════════════════════════════════════════════════════════════
--  ACCESO AL PANEL
-- ════════════════════════════════════════════════════════════════
create table public.usuarios_permitidos (
  email       text primary key check (email = lower(btrim(email)) and email like '%_@_%'),
  nombre      text,
  creado_en   timestamptz not null default now(),
  creado_por  text
);

comment on table public.usuarios_permitidos is
  'Correos que pueden crear cuenta y administrar la web. Todos tienen los mismos permisos.';

-- ¿El usuario de la sesión actual está en la lista?
create or replace function public.es_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.usuarios_permitidos p
    where p.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Estado de un correo para la pantalla de login:
--   'no_permitido' → no está en la lista
--   'sin_password' → está en la lista pero todavía no creó su contraseña
--   'activo'       → ya tiene contraseña
create or replace function public.estado_acceso(p_email text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not exists (select 1 from public.usuarios_permitidos where email = v_email) then
    return 'no_permitido';
  end if;

  if exists (
    select 1 from auth.users u
    where lower(u.email) = v_email
      and u.encrypted_password is not null
      and u.encrypted_password <> ''
  ) then
    return 'activo';
  end if;

  return 'sin_password';
end;
$$;

-- Lista de usuarios para el panel, con su estado (solo para admins)
create or replace function public.listar_usuarios()
returns table (email text, nombre text, creado_en timestamptz, creado_por text, activo boolean, ultimo_ingreso timestamptz)
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
           coalesce(u.encrypted_password is not null and u.encrypted_password <> '', false) as activo,
           u.last_sign_in_at as ultimo_ingreso
    from public.usuarios_permitidos p
    left join auth.users u on lower(u.email) = p.email
    order by p.creado_en;
end;
$$;

-- Hook "Before User Created": bloquea correos que no están en la lista.
create or replace function public.hook_solo_correos_permitidos(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if exists (select 1 from public.usuarios_permitidos where email = v_email) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Este correo no tiene acceso al panel.'
    )
  );
end;
$$;

-- Al quitar un correo de la lista se borra también su cuenta,
-- así pierde la sesión y, si se lo vuelve a agregar, empieza de cero.
create or replace function public.borrar_cuenta_de_correo_quitado()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.users where lower(email) = old.email;
  return old;
end;
$$;

create trigger usuarios_permitidos_borrar_cuenta
  after delete on public.usuarios_permitidos
  for each row execute function public.borrar_cuenta_de_correo_quitado();

-- Normalizar correo y registrar quién lo agregó
create or replace function public.normalizar_usuario_permitido()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(btrim(new.email));
  if new.creado_por is null then
    new.creado_por := auth.jwt() ->> 'email';
  end if;
  return new;
end;
$$;

create trigger usuarios_permitidos_normalizar
  before insert or update on public.usuarios_permitidos
  for each row execute function public.normalizar_usuario_permitido();


-- ════════════════════════════════════════════════════════════════
--  CONTENIDO
-- ════════════════════════════════════════════════════════════════
create table public.avisos (
  id              uuid primary key default gen_random_uuid(),
  titulo          text not null,
  texto           text,
  tipo            text not null default 'normal' check (tipo in ('normal', 'info', 'urgente')),
  fecha           timestamptz not null default now(),
  imagen          text,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index avisos_fecha_idx on public.avisos (fecha desc);

create table public.eventos (
  id              uuid primary key default gen_random_uuid(),
  titulo          text not null,
  texto           text,
  fecha           timestamptz not null,
  imagen          text,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index eventos_fecha_idx on public.eventos (fecha);

create table public.galeria (
  id              uuid primary key default gen_random_uuid(),
  nombre          text not null,
  fecha           timestamptz not null default now(),
  portada         text,
  fotos           text[] not null default '{}',
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index galeria_fecha_idx on public.galeria (fecha desc);

create table public.blog (
  id              uuid primary key default gen_random_uuid(),
  titulo          text not null,
  categoria       text not null default 'Reflexión',
  autor           text not null default 'PIEBA',
  extracto        text,               -- contenido completo del artículo (HTML)
  imagen          text,
  fecha           timestamptz not null default now(),
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index blog_fecha_idx on public.blog (fecha desc);

create table public.miembros (
  id              uuid primary key default gen_random_uuid(),
  nombre          text not null,
  anio            integer,
  rol             text,
  orden           integer not null default 99,
  frase           text,
  referencia      text,
  foto            text,
  es_pastor       boolean not null default false,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create index miembros_orden_idx on public.miembros (orden);

-- Configuración editable de la web (una sola fila, id = 1)
create table public.web_config (
  id              smallint primary key default 1 check (id = 1),
  inicio          jsonb not null default '{}'::jsonb,
  nosotros        jsonb not null default '{}'::jsonb,
  comunidad       jsonb not null default '{}'::jsonb,
  contacto        jsonb not null default '{}'::jsonb,
  ofrendas        jsonb not null default '{}'::jsonb,
  actualizado_en  timestamptz not null default now()
);
insert into public.web_config (id) values (1);

-- Triggers de actualizado_en
create trigger avisos_actualizado     before update on public.avisos     for each row execute function public.tocar_actualizado_en();
create trigger eventos_actualizado    before update on public.eventos    for each row execute function public.tocar_actualizado_en();
create trigger galeria_actualizado    before update on public.galeria    for each row execute function public.tocar_actualizado_en();
create trigger blog_actualizado       before update on public.blog       for each row execute function public.tocar_actualizado_en();
create trigger miembros_actualizado   before update on public.miembros   for each row execute function public.tocar_actualizado_en();
create trigger web_config_actualizado before update on public.web_config for each row execute function public.tocar_actualizado_en();


-- ════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════
alter table public.usuarios_permitidos enable row level security;
alter table public.avisos     enable row level security;
alter table public.eventos    enable row level security;
alter table public.galeria    enable row level security;
alter table public.blog       enable row level security;
alter table public.miembros   enable row level security;
alter table public.web_config enable row level security;

-- Contenido: lectura pública, escritura solo admins
do $$
declare
  t text;
begin
  foreach t in array array['avisos', 'eventos', 'galeria', 'blog', 'miembros'] loop
    execute format('create policy "Lectura pública" on public.%I for select to anon, authenticated using (true)', t);
    execute format('create policy "Admins crean" on public.%I for insert to authenticated with check (public.es_admin())', t);
    execute format('create policy "Admins editan" on public.%I for update to authenticated using (public.es_admin()) with check (public.es_admin())', t);
    execute format('create policy "Admins borran" on public.%I for delete to authenticated using (public.es_admin())', t);
  end loop;
end;
$$;

create policy "Lectura pública" on public.web_config
  for select to anon, authenticated using (true);
create policy "Admins editan" on public.web_config
  for update to authenticated using (public.es_admin()) with check (public.es_admin());

-- Lista de correos: solo admins la ven y la modifican.
-- Nadie puede quitarse a sí mismo (evita quedarse sin acceso).
create policy "Admins ven la lista" on public.usuarios_permitidos
  for select to authenticated using (public.es_admin());
create policy "Admins agregan correos" on public.usuarios_permitidos
  for insert to authenticated with check (public.es_admin());
create policy "Admins editan correos" on public.usuarios_permitidos
  for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy "Admins quitan correos (no el propio)" on public.usuarios_permitidos
  for delete to authenticated
  using (public.es_admin() and email <> lower(coalesce(auth.jwt() ->> 'email', '')));


-- ════════════════════════════════════════════════════════════════
--  PERMISOS (el proyecto no da acceso automático a tablas nuevas)
-- ════════════════════════════════════════════════════════════════
grant usage on schema public to anon, authenticated;

grant select on public.avisos, public.eventos, public.galeria, public.blog, public.miembros, public.web_config
  to anon, authenticated;
grant insert, update, delete on public.avisos, public.eventos, public.galeria, public.blog, public.miembros
  to authenticated;
grant update on public.web_config to authenticated;
grant select, insert, update, delete on public.usuarios_permitidos to authenticated;

revoke execute on function public.es_admin() from public;
grant  execute on function public.es_admin() to anon, authenticated;

revoke execute on function public.estado_acceso(text) from public;
grant  execute on function public.estado_acceso(text) to anon, authenticated;

revoke execute on function public.listar_usuarios() from public, anon;
grant  execute on function public.listar_usuarios() to authenticated;

revoke execute on function public.hook_solo_correos_permitidos(jsonb) from public, anon, authenticated;
grant  execute on function public.hook_solo_correos_permitidos(jsonb) to supabase_auth_admin;

revoke execute on function public.borrar_cuenta_de_correo_quitado() from public, anon, authenticated;


-- ════════════════════════════════════════════════════════════════
--  PRIMER ADMINISTRADOR (los demás se agregan desde el panel → Usuarios)
-- ════════════════════════════════════════════════════════════════
insert into public.usuarios_permitidos (email, nombre, creado_por)
values ('ozkrv1@gmail.com', 'Oscar', 'migración inicial')
on conflict (email) do nothing;
