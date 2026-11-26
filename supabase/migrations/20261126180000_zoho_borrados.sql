-- Correos traídos de Zoho que el usuario borró: la copia desde Zoho no los
-- vuelve a traer.
create table if not exists public.buzon_zoho_borrados (
  buzon       text not null references public.buzones (email) on delete cascade,
  message_id  text not null,
  borrado_en  timestamptz not null default now(),
  primary key (buzon, message_id)
);
alter table public.buzon_zoho_borrados enable row level security;
revoke all on public.buzon_zoho_borrados from anon, authenticated;
