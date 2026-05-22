// Log de conversaciones con pacientes (tabla `conversations` en Supabase de Mirai).
// Guarda lo que escribe el paciente, lo que escribe Mirai manualmente,
// y lo que escribe Mia. Mia ve el historial como contexto.

import { miraiSupabase } from '../../lib/miraiSupabase.js';

export async function logMessage({
  patientId,
  author,           // 'patient' | 'mirai' | 'mia'
  content,
  messageType = 'text',
  whatsappMessageId = null,
  metadata = null,
}) {
  if (!miraiSupabase) return null;
  if (!patientId || !author || !content) return null;

  const { data, error } = await miraiSupabase
    .from('conversations')
    .insert({
      patient_id: patientId,
      author,
      content: String(content).slice(0, 8000),
      message_type: messageType,
      whatsapp_message_id: whatsappMessageId,
      metadata,
    })
    .select()
    .single();

  if (error) {
    // Dedupe por whatsapp_message_id si lo agregamos como UNIQUE en el futuro.
    if (error.code === '23505') return null;
    console.error('[mia/conversations] logMessage error:', error.message);
    return null;
  }
  return data;
}

export async function recentMessages(patientId, limit = 20) {
  if (!miraiSupabase || !patientId) return [];
  const { data, error } = await miraiSupabase
    .from('conversations')
    .select('author, content, message_type, created_at, metadata')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[mia/conversations] recentMessages error:', error.message);
    return [];
  }
  return (data ?? []).reverse(); // orden cronológico
}

// Silencio inteligente:
// - Si Mia NUNCA ha hablado con este paciente, es la apertura inicial de
//   Mirai → no silenciar (Mia debe tomar control del triage).
// - Si Mia ya habló Y el último mensaje de Mirai es más reciente que el
//   último de Mia, significa que Mirai retomó la conversación manualmente
//   en medio del flujo → silenciar X minutos (default 5).
// - El parámetro `silenceMinutes=0` desactiva el silencio completamente
//   incluso en caso de retomar (modo "Mia nunca calla").
export async function shouldMiaBeSilent(patientId, silenceMinutes) {
  if (!miraiSupabase || !patientId) return false;
  if (silenceMinutes === 0) return false;

  const { data, error } = await miraiSupabase
    .from('conversations')
    .select('author, created_at')
    .eq('patient_id', patientId)
    .in('author', ['mia', 'mirai'])
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[mia/conversations] shouldMiaBeSilent error:', error.message);
    return false;
  }
  const rows = data ?? [];

  // Buscar el último de Mia y el último de Mirai.
  let lastMia = null;
  let lastMirai = null;
  for (const r of rows) {
    if (!lastMia   && r.author === 'mia')   lastMia   = r.created_at;
    if (!lastMirai && r.author === 'mirai') lastMirai = r.created_at;
    if (lastMia && lastMirai) break;
  }

  // Si Mia nunca ha hablado, es apertura inicial → no silenciar.
  if (!lastMia) return false;

  // Si no hay mensaje de Mirai posterior, no silenciar.
  if (!lastMirai) return false;

  // Si el último de Mirai NO es posterior al último de Mia, no silenciar.
  if (lastMirai <= lastMia) return false;

  // Mirai retomó tras Mia. Silenciar si fue hace menos de X minutos.
  const since = new Date(Date.now() - silenceMinutes * 60_000).toISOString();
  return lastMirai > since;
}

// Backwards-compat: nombre viejo. Mantenido para evitar romper imports.
export const lastMiraiManualMessageWithinMinutes = shouldMiaBeSilent;
