-- ════════════════════════════════════════════════════════════════
--  PIEBA Mail · dispositivos registrados para avisos push
-- ════════════════════════════════════════════════════════════════
--  Una fila por teléfono. Los tokens de Zoho se guardan CIFRADOS
--  (AES-GCM, clave en el secreto MAIL_CIFRADO_KEY de la función).
--  Sin políticas RLS: solo la función mail-push (service_role) accede;
--  la web y el público no pueden leer ni escribir esta tabla.
create table public.mail_dispositivos (
  fcm_token              text primary key,
  email                  text not null check (email like '%@primeradeasuncion.org.py'),
  account_id             text not null,
  api_host               text not null default 'mail.zoho.com',
  inbox_folder_id        text not null,
  refresh_token_cifrado  text not null,
  access_token_cifrado   text,
  access_token_expira    timestamptz,
  ultimo_recibido        bigint not null default 0,
  errores_seguidos       integer not null default 0,
  ultimo_error           text,
  creado_en              timestamptz not null default now(),
  actualizado_en         timestamptz not null default now()
);
create index mail_dispositivos_email_idx on public.mail_dispositivos (email);

alter table public.mail_dispositivos enable row level security;
revoke all on public.mail_dispositivos from anon, authenticated;
grant select, insert, update, delete on public.mail_dispositivos to service_role;
