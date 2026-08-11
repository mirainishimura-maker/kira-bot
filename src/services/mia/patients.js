// CRUD de la whitelist de pacientes de Mirai.
// La tabla `patients` vive en el Supabase privado de Mirai.

import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { config } from '../../config.js';

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

// ─── Categorías: TRES cosas distintas que la tabla mezclaba ───────────
//
// La tabla `patients` guarda a todo el que alguna vez escribió por WhatsApp.
// Eso NO son pacientes. Hay que separar (regla de Mirai, 11 ago 2026):
//   · PACIENTE   = la ve en consulta actualmente, es a quien le da seguimiento.
//   · LEAD       = alguien que escribió; se distingue por ORIGEN (campaña,
//                  Mont Sinai —fuente ya cerrada—, u orgánico).
//   · SILENCIADA = estado CONVERSACIONAL (Mia no le responde). Es ortogonal:
//                  una paciente real puede estar silenciada porque Mirai la
//                  atiende a mano. NO define si es paciente o no.
//
// La `etiqueta` es la fuente de verdad de la CATEGORÍA, y el `estado` la del
// momento conversacional. Nunca mezclarlos al listar.
export const ETIQUETAS_PACIENTE = ['paciente', 'paciente_activo', 'consultorio'];
export const ETIQUETAS_LEAD = {
  campaña:   'lead_campaña',
  montsinai: 'lead_montsinai',
  organico:  'lead_organico',
};

// Pacientes actuales en consulta — lo que Mirai pide cuando dice "mis
// pacientes". Incluye a las silenciadas (siguen siendo sus pacientes) pero lo
// marca, para que sepa a quién atiende ella a mano.
export async function listPacientesActivos() {
  if (!miraiSupabase) return [];
  const [pRes, sRes] = await Promise.all([
    miraiSupabase.from('patients')
      .select('id, nombre, phone, etiqueta, estado')
      .in('etiqueta', ETIQUETAS_PACIENTE).neq('estado', 'alta'),
    miraiSupabase.from('sessions').select('patient_id, session_date, created_at'),
  ]);

  const sesiones = new Map();   // id → { n, ultima }
  for (const s of sRes.data ?? []) {
    const cur = sesiones.get(s.patient_id) ?? { n: 0, ultima: null };
    cur.n += 1;
    const f = s.session_date || s.created_at;
    if (f && (!cur.ultima || f > cur.ultima)) cur.ultima = f;
    sesiones.set(s.patient_id, cur);
  }

  const miNumero = normalizePhone(config.mia.personalPhone);
  return (pRes.data ?? [])
    .filter((p) => normalizePhone(p.phone) !== miNumero)
    .map((p) => {
      const s = sesiones.get(p.id);
      return {
        nombre: p.nombre,
        phone: p.phone,
        estado: p.estado,
        sesiones: s?.n ?? 0,
        ultima_sesion: s?.ultima ?? null,
        en_pausa: p.estado === 'silenciada',
      };
    })
    .sort((a, b) => (b.ultima_sesion || '').localeCompare(a.ultima_sesion || '') || a.nombre.localeCompare(b.nombre));
}

// Leads por ORIGEN. `origen` ∈ campaña | montsinai | organico | null (todos).
export async function listLeads(origen = null) {
  if (!miraiSupabase) return [];
  const etiquetas = origen ? [ETIQUETAS_LEAD[origen]].filter(Boolean) : Object.values(ETIQUETAS_LEAD);
  if (!etiquetas.length) return [];
  const { data } = await miraiSupabase.from('patients')
    .select('nombre, phone, etiqueta, estado')
    .in('etiqueta', etiquetas).neq('estado', 'alta')
    .order('fecha_alta', { ascending: false });
  return (data ?? []).map((p) => ({
    nombre: p.nombre, phone: p.phone, estado: p.estado,
    origen: Object.keys(ETIQUETAS_LEAD).find((k) => ETIQUETAS_LEAD[k] === p.etiqueta) ?? 'otro',
    en_pausa: p.estado === 'silenciada',
  }));
}

// Marca a alguien como PACIENTE actual (o lo devuelve a lead). Es lo que
// arregla la categoría cuando un lead se convierte en paciente de verdad.
export async function marcarComoPaciente(phone, esPaciente = true) {
  if (!miraiSupabase) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const { data, error } = await miraiSupabase
    .from('patients')
    .update({ etiqueta: esPaciente ? 'paciente' : 'lead_organico' })
    .eq('phone', normalized).select().maybeSingle();
  if (error) { console.error('[mia/patients] marcarComoPaciente:', error.message); return null; }
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

// Guarda/actualiza el motivo de consulta en la ficha (ej. el nivel del test
// de ansiedad con el que llegó el lead del funnel NEURA). Best-effort: si
// falla, loguea y devuelve null (no rompe el flujo del webhook).
export async function setPatientMotivo(phone, motivo) {
  if (!miraiSupabase) return null;
  const normalized = normalizePhone(phone);
  if (!normalized || !motivo) return null;

  const { data, error } = await miraiSupabase
    .from('patients')
    .update({ motivo })
    .eq('phone', normalized)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[mia/patients] setPatientMotivo error:', error.message);
    return null;
  }
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
