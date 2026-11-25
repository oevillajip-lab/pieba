-- ════════════════════════════════════════════════════════════════
--  PIEBA Mail · hasta 3 cuentas por teléfono
-- ════════════════════════════════════════════════════════════════
--  Antes: una fila por teléfono (fcm_token). Ahora: una fila por
--  teléfono + cuenta, así llegan avisos de todas las cuentas del teléfono.
alter table public.mail_dispositivos drop constraint if exists mail_dispositivos_pkey;
alter table public.mail_dispositivos add primary key (fcm_token, email);
create index if not exists mail_dispositivos_token_idx on public.mail_dispositivos (fcm_token);
