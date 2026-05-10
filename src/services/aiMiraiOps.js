// Tools + handlers para el espacio mirai_ops.
// El endpoint y secret se leen de Supabase (spaces.slug='mirai_ops') vía spaces.js.

import { callSpaceEndpoint, getSpaceBySlug } from './spaces.js';

export const MIRAI_OPS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'log_personal_task',
      description:
        'Registra una tarea nueva en la hoja personal de Mirai. Úsala cada vez que Mirai mencione algo que tiene que hacer, un pendiente, un compromiso o algo para estudiar. Si menciona varias tareas en un mensaje, llama a la tool una vez por cada tarea.',
      parameters: {
        type: 'object',
        properties: {
          fecha:           { type: 'string', description: 'Fecha de creación en dd/mm/yyyy. Usa la fecha de hoy.' },
          proyecto:        { type: 'string', description: 'Proyecto al que pertenece. Sugerencias: Ítaca HUB, Ítaca Kids, ECO Canto, Conversemos, EMDR/UNIR, SERUMS, Personal.' },
          tarea:           { type: 'string', description: 'Descripción corta y clara. Máximo 80 caracteres.' },
          tipo:            { type: 'string', enum: ['desarrollo','reunión','revisión','decisión','admin','contenido','otro'], description: 'Categoría de la tarea.' },
          prioridad:       { type: 'string', enum: ['🔴 Urgente','🟡 Alta','🔵 Normal','🟢 Baja'], description: 'Prioridad con emoji (los valores literales que entiende la hoja). Default 🔵 Normal.' },
          fechaCompromiso: { type: 'string', description: 'Fecha límite en dd/mm/yyyy. Vacío si no hay deadline.' },
          observaciones:   { type: 'string', description: 'Notas adicionales. Vacío si no hay.' },
        },
        required: ['fecha','proyecto','tarea','tipo','prioridad'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_personal_task',
      description:
        'Actualiza una tarea existente. Principal uso: marcar como ✅ Entregado cuando Mirai dice que terminó algo. La búsqueda matcha por (fecha + texto parcial de tarea); si no encuentra match, crea una fila nueva en lugar de fallar.',
      parameters: {
        type: 'object',
        properties: {
          fecha:           { type: 'string', description: 'Fecha de la tarea a buscar (dd/mm/yyyy).' },
          tarea:           { type: 'string', description: 'Texto parcial o completo de la tarea a buscar.' },
          estado:          { type: 'string', enum: ['⬜ Por realizar','🔄 En proceso','✅ Entregado','❌ No entregado','⏸️ Bloqueado'], description: 'Nuevo estado.' },
          prioridad:       { type: 'string', enum: ['🔴 Urgente','🟡 Alta','🔵 Normal','🟢 Baja'], description: 'Nueva prioridad (opcional).' },
          observaciones:   { type: 'string', description: 'Observaciones a agregar/reemplazar (opcional).' },
        },
        required: ['fecha','tarea','estado'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_personal_tasks',
      description:
        'Lee tareas con filtros opcionales. Úsala cuando Mirai pregunte qué tiene pendiente, qué hizo, o pida un resumen. Sin filtros devuelve las últimas 50 ordenadas de más nueva a más vieja.',
      parameters: {
        type: 'object',
        properties: {
          fecha:    { type: 'string', description: 'Fecha exacta dd/mm/yyyy.' },
          proyecto: { type: 'string', description: 'Substring del proyecto (case-insensitive).' },
          estado:   { type: 'string', description: 'Substring del estado: "Entregado", "En proceso", "Por realizar", "Bloqueado", "No entregado".' },
          limit:    { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        },
        additionalProperties: false,
      },
    },
  },
];

let cachedSpace = null;
async function getSpace() {
  if (!cachedSpace) cachedSpace = await getSpaceBySlug('mirai_ops');
  if (!cachedSpace) throw new Error('Espacio mirai_ops no encontrado en Supabase.');
  return cachedSpace;
}

export async function executeMiraiOpsTool(name, args) {
  const space = await getSpace();
  try {
    if (name === 'log_personal_task') {
      const data = await callSpaceEndpoint(space, 'append', {
        fecha:           args.fecha,
        proyecto:        args.proyecto,
        tarea:           args.tarea,
        tipo:            args.tipo,
        prioridad:       args.prioridad,
        estado:          '⬜ Por realizar',
        fechaCompromiso: args.fechaCompromiso || '',
        observaciones:   args.observaciones || '',
      });
      return { ok: true, appended_row: data.appended_row };
    }
    if (name === 'update_personal_task') {
      // El Apps Script tiene una sola action `update` que hace upsert por
      // (fecha, tarea). Si no existe lo crea como append. Mapeamos los
      // campos opcionales: solo se aplican los no vacíos.
      const data = await callSpaceEndpoint(space, 'update', {
        fecha:         args.fecha,
        tarea:         args.tarea,
        estado:        args.estado,
        prioridad:     args.prioridad     || '',
        observaciones: args.observaciones || '',
      });
      return { ok: true, updated_row: data.updated_row ?? data.appended_row };
    }
    if (name === 'read_personal_tasks') {
      const data = await callSpaceEndpoint(space, 'read', {
        fecha:    args.fecha    || '',
        proyecto: args.proyecto || '',
        estado:   args.estado   || '',
        limit:    args.limit    || 50,
      });
      return { ok: true, rows: data.rows ?? [], count: data.count ?? 0 };
    }
    return { ok: false, error: `Tool desconocida: ${name}` };
  } catch (err) {
    console.error(`[mirai_ops tool] ${name} fallo:`, err.message);
    return { ok: false, error: err.message };
  }
}

export function isMiraiOpsTool(name) {
  return name === 'log_personal_task' || name === 'update_personal_task' || name === 'read_personal_tasks';
}
