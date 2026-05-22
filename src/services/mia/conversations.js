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

// Detecta si el último mensaje "mirai" (manual) fue hace menos de X minutos.
// Si sí, Mia entra en modo silencio para no interrumpir.
export async function lastMiraiManualMessageWithinMinutes(patientId, minutes) {
  if (!miraiSupabase || !patientId) return false;
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { data, error } = await miraiSupabase
    .from('conversations')
    .select('id')
    .eq('patient_id', patientId)
    .eq('author', 'mirai')
    .gt('created_at', since)
    .limit(1);

  if (error) {
    console.error('[mia/conversations] lastMiraiManual error:', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
