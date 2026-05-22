// Cliente Supabase del proyecto PRIVADO de Mirai (módulo Mia).
// Aislado del Supabase de la empresa que usa KIRA-mkt. Si las env vars
// MIRAI_SUPABASE_* no están, exportamos null y el resto del módulo Mia
// debe chequear config.mia.enabled antes de usarlo.

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Normalizamos: Supabase falla con "Invalid path" si la URL trae path
// (ej: ".../rest/v1/") o termina con "/". Nos quedamos solo con el origin.
function normalizeSupabaseUrl(raw) {
  if (!raw) return raw;
  try {
    return new URL(raw).origin; // "https://xxx.supabase.co"
  } catch {
    return raw.replace(/\/+$/, '');
  }
}
const url = normalizeSupabaseUrl(config.mia.supabase.url);

export const miraiSupabase = config.mia.enabled
  ? createClient(
      url,
      config.mia.supabase.serviceRoleKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
  : null;
