// Conexión compartida a Supabase para todas las páginas.
// La clave "publishable" es pública por diseño: la seguridad real
// está en las reglas RLS de la base de datos (supabase/migrations).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://ywftajhexpnofsoupfht.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_toCu6NDhiY3cGz5eBbHTvA_5qUgpH2J';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Lanza el error de Supabase si lo hay; si no, devuelve los datos.
export function ok({ data, error }) {
  if (error) throw error;
  return data;
}
