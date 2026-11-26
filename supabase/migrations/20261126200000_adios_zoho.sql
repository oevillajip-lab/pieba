-- Fin de Zoho: se borran las tablas y funciones que solo servían para Zoho.

-- Lista de teléfonos del panel: ahora sale de los teléfonos del correo propio.
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
           max(d.ultimo_uso),
           bool_or(d.avisos_correo), bool_or(d.avisos_comunicados),
           exists (select 1 from public.mail_admins a where a.email = d.email)
    from public.buzon_dispositivos d
    group by d.email
    order by d.email;
end;
$$;

-- Teléfonos registrados con la app anterior (tokens de Zoho cifrados).
drop table if exists public.mail_dispositivos;
-- Borrados recordados para la copia desde Zoho.
drop table if exists public.buzon_zoho_borrados;

-- Administradores de la app que ya no tienen cuenta de correo.
delete from public.mail_admins a
 where not exists (select 1 from public.buzones b where b.email = a.email);
