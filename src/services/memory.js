import { supabase } from '../lib/supabase.js';

const TODAY = () => new Date().toISOString().slice(0, 10);

// Devuelve los últimos N resúmenes recientes del miembro.
export async function recentMemory(memberId, limit = 5) {
  if (!memberId) return [];
  const { data, error } = await supabase
    .from('kira_memory')
    .select('conversation_date, channel, summary, action_items, created_at')
    .eq('member_id', memberId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[memory] error leyendo', error);
    return [];
  }
  return data;
}

export async function saveMemory({ memberId, channel, summary, actionItems = null }) {
  if (!memberId || !summary) return;
  const { error } = await supabase.from('kira_memory').insert({
    member_id: memberId,
    conversation_date: TODAY(),
    channel,
    summary,
    action_items: actionItems,
  });
  if (error) console.error('[memory] error escribiendo', error);
}

// Tareas activas del miembro: pending, in_progress, blocked.
export async function activeTasks(memberId) {
  if (!memberId) return [];
  const { data, error } = await supabase
    .from('tasks')
    .select(`
      id, title, description, task_type, status, priority, due_date,
      project:project_id ( id, title, client:client_id ( id, name ) )
    `)
    .eq('assigned_to', memberId)
    .in('status', ['pending', 'in_progress', 'blocked'])
    .order('due_date', { ascending: true, nullsFirst: false });
  if (error) {
    console.error('[memory] error tareas', error);
    return [];
  }
  return data;
}
