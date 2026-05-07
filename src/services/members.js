import { supabase } from '../lib/supabase.js';

// Extrae el número E.164 (sin +) de un JID de WhatsApp.
// Solo @s.whatsapp.net y @c.us contienen el número real.
// @lid es un Linked ID opaco — sus dígitos NO son el teléfono.
// Ignora también el ":N" de device id (ej: "51999...:23@s.whatsapp.net").
export function phoneFromJid(jid) {
  if (!jid) return null;
  const cleaned = String(jid).replace(/:\d+@/, '@');
  const m = cleaned.match(/^(\d{10,15})@(?:s\.whatsapp\.net|c\.us)$/);
  return m ? m[1] : null;
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
