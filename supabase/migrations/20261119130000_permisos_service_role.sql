-- El proyecto no da permisos automáticos a tablas nuevas, así que el rol
-- service_role (clave secreta: scripts de mantenimiento/migración) necesita
-- permisos explícitos. Este rol ignora RLS y nunca se usa desde el navegador.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
