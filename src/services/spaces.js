// Cliente genérico para los espacios de KIRA.
// Carga la configuración desde Supabase (tabla `spaces`) y expone un helper
// para llamar al Apps Script Web App de cada espacio usando sheet_url +
// sheet_secret. Todos los endpoints siguen el mismo contrato: body con
// { secret, action, ...payload } y respuesta JSON con { ok, ... }.

import { supabase } from '../lib/supabase.js';

// ─── Carga de espacios ────────────────────────────────────────────────

export async function listSpacesByKind(kind) {
  const { data, error } = await supabase
    .from('spaces')
    .select('id, slug, name, kind, group_jid, sheet_id, sheet_url, sheet_secret, config')
    .eq('kind', kind)
    .eq('is_active', true)
    .order('slug');
  if (error) throw error;
  return data ?? [];
}

export async function getSpaceBySlug(slug) {
  const { data, error } = await supabase
    .from('spaces')
    .select('id, slug, name, kind, group_jid, sheet_id, sheet_url, sheet_secret, config')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Devuelve los slugs de los espacios a los que pertenece un miembro.
// Útil para el ruteo: definir qué SYSTEM_PROMPT y tools usar según el espacio.
export async function getMemberSpaceSlugs(memberId) {
  if (!memberId) return [];
  const { data, error } = await supabase
    .from('space_members')
    .select('spaces(slug, is_active)')
    .eq('member_id', memberId);
  if (error) throw error;
  return (data ?? [])
    .map(r => r.spaces)
    .filter(s => s && s.is_active)
    .map(s => s.slug);
}

// Devuelve el owner (is_owner=true) más reciente de un espacio.
// Para birthday_reminders y personal_ops hay un solo owner.
export async function getSpaceOwner(spaceId) {
  const { data, error } = await supabase
    .from('space_members')
    .select('member_id, is_owner, team_members(id, name, phone, role, is_active)')
    .eq('space_id', spaceId)
    .eq('is_owner', true);
  if (error) throw error;
  const row = (data ?? []).find(r => r.team_members?.is_active);
  return row ? row.team_members : null;
}

// ─── HTTP al Apps Script ──────────────────────────────────────────────

export async function callSpaceEndpoint(space, action, payload = {}) {
  if (!space?.sheet_url || !space?.sheet_secret) {
    throw new Error(`Espacio "${space?.slug}" no tiene sheet_url/sheet_secret configurados.`);
  }
  const res = await fetch(space.sheet_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: space.sheet_secret, action, ...payload }),
    redirect: 'follow',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.ok === false) {
    const err = new Error(`Endpoint ${space.slug} ${action} -> ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data   = data;
    throw err;
  }
  return data;
}
