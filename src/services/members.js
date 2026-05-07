import { supabase } from '../lib/supabase.js';

// Convierte "51999999999@s.whatsapp.net" → "51999999999"
export function phoneFromJid(jid) {
  if (!jid) return null;
  const match = jid.match(/^(\d{10,15})@s\.whatsapp\.net$/);
  return match ? match[1] : null;
}

// Devuelve el miembro identificado por número, o null si no existe.
export async function findMemberByPhone(phone) {
  if (!phone) return null;
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, role, phone, is_admin, daily_capacity, availability_notes')
    .eq('phone', phone)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    console.error('[members] error', error);
    return null;
  }
  return data;
}

export async function listActiveMembers() {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, role, is_admin, daily_capacity, availability_notes')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data;
}
