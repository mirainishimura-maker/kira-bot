// CRUD de la whitelist de pacientes de Mirai.
// La tabla `patients` vive en el Supabase privado de Mirai.

import { miraiSupabase } from '../../lib/miraiSupabase.js';

// Normaliza un teléfono a E.164 sin "+" ni @s.whatsapp.net.
// Ej: "+51 987-654-321" → "51987654321"
//     "51987654321@s.whatsapp.net" → "51987654321"
export function normalizePhone(input) {
  if (!input) return null;
  return String(input).replace(/@s\.whatsapp\.net$/, '').replace(/[^\d]/g, '') || null;
}

export async function findPatientByPhone(phone) {
  if (!miraiSupabase) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const { data, error } = await miraiSupabase
    .from('patients')
    .select('*')
    .eq('phone', normalized)
    .maybeSingle();

  if (error) {
    console.error('[mia/patients] findPatientByPhone error:', error.message);
    return null;
  }
  return data;
}

export async function addPatient({ phone, nombre, etiqueta }) {
  if (!miraiSupabase) throw new Error('Mia no está habilitado (faltan env vars MIRAI_*)');
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Teléfono inválido');
  if (!nombre || !nombre.trim()) throw new Error('Nombre requerido');

  const { data, error } = await miraiSupabase
    .from('patients')
    .insert({
      phone: normalized,
      nombre: nombre.trim(),
      etiqueta: etiqueta?.trim() || 'paciente_activo',
      estado: 'nuevo',
    })
    .select()
    .single();

  if (error) {
    // Duplicado (UNIQUE constraint) → devolver paciente existente.
    if (error.code === '23505') {
      return { duplicated: true, patient: await findPatientByPhone(normalized) };
    }
    throw new Error(`No pude agregar paciente: ${error.message}`);
  }
  return { duplicated: false, patient: data };
}

// Auto-intake (embudo NEURA): crea un lead automáticamente cuando un número
// NUEVO escribe. No exige nombre (el lead aún no lo dio). Si ya existía por una
// carrera de mensajes, lo devuelve. Devuelve null si falla (el webhook ignora).
export async function createLeadAuto({ phone, nombre }) {
  if (!miraiSupabase) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const { data, error } = await miraiSupabase
    .from('patients')
    .insert({
      phone: normalized,
      nombre: (nombre && nombre.trim()) ? nombre.trim() : 'Nuevo lead',
      etiqueta: 'lead_organico',
      estado: 'nuevo',
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') return await findPatientByPhone(normalized); // carrera: ya existía
    console.error('[mia/patients] createLeadAuto error:', error.message);
    return null;
  }
  return data;
}

export async function listActivePatients() {
  if (!miraiSupabase) return [];
  const { data, error } = await miraiSupabase
    .from('patients')
    .select('phone, nombre, etiqueta, estado, fecha_alta')
    .neq('estado', 'alta')
    .order('fecha_alta', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[mia/patients] listActivePatients error:', error.message);
    return [];
  }
  return data ?? [];
}

// Trae TODOS los leads/pacientes con los campos que el reporte necesita.
// Sin filtro de estado (incluye alta/silenciada): el reporte los agrupa.
// Volumen bajo — el límite por defecto de Supabase (1000 filas) sobra.
export async function listAllForReport() {
  if (!miraiSupabase) return [];
  const { data, error } = await miraiSupabase
    .from('patients')
    .select('estado, etiqueta, fecha_alta')
    .order('fecha_alta', { ascending: false });

  if (error) {
    console.error('[mia/patients] listAllForReport error:', error.message);
    return [];
  }
  return data ?? [];
}

export async function removePatient(phone) {
  if (!miraiSupabase) throw new Error('Mia no está habilitado');
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Teléfono inválido');

  const { data, error } = await miraiSupabase
    .from('patients')
    .update({ estado: 'alta' })
    .eq('phone', normalized)
    .select()
    .maybeSingle();

  if (error) throw new Error(`No pude dar de alta paciente: ${error.message}`);
  return data;
}

// Cambia el estado de un paciente. Se usa para silenciar/reactivar a Mia:
//   estado='silenciada' → el webhook no enruta sus mensajes a Mia.
//   estado='datos_parciales' (u otro) → Mia vuelve a responder.
export async function setPatientEstado(phone, estado) {
  if (!miraiSupabase) throw new Error('Mia no está habilitado');
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Teléfono inválido');
  if (!estado) throw new Error('Estado requerido');

  const { data, error } = await miraiSupabase
    .from('patients')
    .update({ estado })
    .eq('phone', normalized)
    .select()
    .maybeSingle();

  if (error) throw new Error(`No pude cambiar el estado: ${error.message}`);
  return data;
}

export async function addNoteToPatient(phone, nota) {
  if (!miraiSupabase) throw new Error('Mia no está habilitado');
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Teléfono inválido');
  if (!nota || !nota.trim()) throw new Error('Nota vacía');

  const existing = await findPatientByPhone(normalized);
  if (!existing) return null;

  const stamp = new Date().toISOString().slice(0, 10);
  const nuevaNota = `[${stamp}] ${nota.trim()}`;
  const notasActualizadas = existing.notas
    ? `${existing.notas}\n${nuevaNota}`
    : nuevaNota;

  const { data, error } = await miraiSupabase
    .from('patients')
    .update({ notas: notasActualizadas })
    .eq('phone', normalized)
    .select()
    .single();

  if (error) throw new Error(`No pude actualizar nota: ${error.message}`);
  return data;
}

export async function touchPatientInteraction(patientId, { authorCounted } = {}) {
  if (!miraiSupabase) return;
  // increment seguro: leemos y escribimos. Volúmenes bajos, no hace falta RPC.
  const { data, error } = await miraiSupabase
    .from('patients')
    .select('total_mensajes_paciente, total_mensajes_mia, total_mensajes_mirai')
    .eq('id', patientId)
    .maybeSingle();

  if (error || !data) return;

  const updates = { fecha_ultima_interaccion: new Date().toISOString() };
  if (authorCounted === 'patient') updates.total_mensajes_paciente = (data.total_mensajes_paciente ?? 0) + 1;
  if (authorCounted === 'mia')     updates.total_mensajes_mia      = (data.total_mensajes_mia      ?? 0) + 1;
  if (authorCounted === 'mirai')   updates.total_mensajes_mirai    = (data.total_mensajes_mirai    ?? 0) + 1;

  await miraiSupabase.from('patients').update(updates).eq('id', patientId);
}
