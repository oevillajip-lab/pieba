-- Supabase asigna una contraseña aleatoria interna a las cuentas creadas
-- con código (OTP), así que "tiene contraseña" no sirve para saber si la
-- persona ya creó la suya. Se registra cuando la contraseña CAMBIA.

alter table public.usuarios_permitidos
  add column if not exists password_creada boolean not null default false;

-- Cuando Auth actualiza la contraseña de un usuario (crear / recuperar),
-- marcarlo como activo.
create or replace function public.marcar_password_creada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.usuarios_permitidos
       set password_creada = true
     where email = lower(new.email);
  end if;
  return new;
end;
$$;

drop trigger if exists auth_users_marcar_password_creada on auth.users;
create trigger auth_users_marcar_password_creada
  after update of encrypted_password on auth.users
  for each row execute function public.marcar_password_creada();

revoke execute on function public.marcar_password_creada() from public, anon, authenticated;

-- Estado para la pantalla de login
create or replace function public.estado_acceso(p_email text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_creada boolean;
begin
  select p.password_creada into v_creada
  from public.usuarios_permitidos p where p.email = v_email;

  if not found then
    return 'no_permitido';
  end if;

  if v_creada and exists (select 1 from auth.users u where lower(u.email) = v_email) then
    return 'activo';
  end if;

  return 'sin_password';
end;
$$;

-- Lista de usuarios del panel
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
           (p.password_creada and u.id is not null) as activo,
           u.last_sign_in_at as ultimo_ingreso
    from public.usuarios_permitidos p
    left join auth.users u on lower(u.email) = p.email
    order by p.creado_en;
end;
$$;
