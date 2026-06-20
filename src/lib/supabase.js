import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Cliente Supabase de la EMPRESA (KIRA-mkt). En modo MIA_ONLY no hay credenciales
// corporativas, así que exportamos null — ningún path de Mia usa este cliente.
export const supabase = config.supabase.url
  ? createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    )
  : null;
