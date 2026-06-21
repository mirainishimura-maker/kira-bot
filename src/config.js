import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta variable de entorno: ${name}`);
  return value;
}

// MIA_ONLY=true → el proceso levanta SOLO el módulo Mia (triage de pacientes de
// Mirai), sin KIRA-mkt. En ese modo las credenciales de la EMPRESA (Supabase y
// OpenAI corporativos) dejan de ser obligatorias: Mia usa las suyas (MIRAI_*) y
// la Evolution sigue siendo necesaria (Mia manda/recibe WhatsApp por ahí).
const MIA_ONLY = process.env.MIA_ONLY === 'true';

// Requerido salvo en modo Mia-only, donde KIRA-mkt no corre: devolvemos '' para
// no romper el arranque cuando esa credencial corporativa no esté.
function companyRequired(name) {
  return MIA_ONLY ? (process.env[name] || '') : required(name);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  env: process.env.NODE_ENV ?? 'development',
  tz: process.env.TZ ?? 'America/Lima',
  miaOnly: MIA_ONLY,

  supabase: {
    url: companyRequired('SUPABASE_URL'),
    serviceRoleKey: companyRequired('SUPABASE_SERVICE_ROLE_KEY'),
  },

  evolution: {
    url: required('EVOLUTION_API_URL'),
    apiKey: required('EVOLUTION_API_KEY'),
    instance: required('EVOLUTION_INSTANCE_NAME'),
    // GROUP_JID se captura automáticamente al recibir el primer mensaje del grupo.
    groupJid: process.env.GROUP_JID || null,
  },

  openai: {
    apiKey: companyRequired('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1',
  },

  // Apps Script Web App de la hoja de productividad de Luisa. Opcional —
  // si no está configurado, KIRA simplemente no escribe en la hoja.
  sheets: {
    url:    process.env.SHEETS_WEBHOOK_URL    || null,
    secret: process.env.SHEETS_WEBHOOK_SECRET || null,
  },

  webhookSecret: process.env.WEBHOOK_SECRET ?? '',

  // Módulo Mia (clínica privada de Mirai). Todo opcional: si falta cualquier
  // pieza, mia.enabled = false y el webhook no la activa. KIRA-mkt sigue
  // funcionando intacto.
  mia: (() => {
    const url      = process.env.MIRAI_SUPABASE_URL || '';
    const key      = process.env.MIRAI_SUPABASE_SERVICE_ROLE_KEY || '';
    const aiKey    = process.env.MIRAI_OPENAI_API_KEY || '';
    const personal = process.env.MIRAI_PERSONAL_PHONE || '';
    // Lista de números autorizados a enviar notas de leads desde su propio
    // WhatsApp (ej: la asistente de la clínica). Pueden hacer intake de
    // leads pero NO comandos administrativos — eso queda solo para Mirai.
    const operatorPhones = (process.env.MIA_OPERATOR_PHONES || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return {
      enabled: Boolean(url && key && aiKey && personal),
      supabase: { url, serviceRoleKey: key },
      openai:   { apiKey: aiKey, model: process.env.MIRAI_OPENAI_MODEL || 'gpt-4o-mini' },
      personalPhone: personal,
      operatorPhones,
      // Silencio inteligente: si Mirai retoma manual EN MEDIO de un flujo de
      // Mia (ya hubo mensaje de Mia previo), Mia se calla X minutos. La
      // apertura inicial (sin mensaje previo de Mia) NUNCA silencia, sin
      // importar el valor de aquí. Pon 0 para desactivar completamente.
      silenceAfterMiraiMinutes: (() => {
        const n = Number(process.env.MIA_SILENCE_AFTER_MIRAI_MINUTES);
        return Number.isFinite(n) && n >= 0 ? n : 5;
      })(),
      // Debounce de mensajes entrantes: Mia espera una ventana de silencio
      // antes de procesar, agrupando los mensajes que lleguen del mismo
      // paciente. Cada mensaje nuevo REINICIA la ventana (deslizante), así
      // espera a que el paciente termine de escribir. Default 30 segundos.
      // Robusto contra env var vacía/inválida: usa 30s en esos casos.
      debounceMs: (() => {
        const n = Number(process.env.MIA_DEBOUNCE_MS);
        return Number.isFinite(n) && n > 0 ? n : 30_000;
      })(),
      // Tope máximo del lote: aunque el paciente siga escribiendo y reinicie
      // la ventana deslizante, el lote se cierra a la fuerza al llegar a este
      // tope. Evita que un paciente muy hablador retrase la respuesta para
      // siempre. Default 2 minutos.
      debounceMaxMs: (() => {
        const n = Number(process.env.MIA_DEBOUNCE_MAX_MS);
        return Number.isFinite(n) && n > 0 ? n : 120_000;
      })(),
      // URLs públicas de imágenes que Mia puede enviar. La key del map debe
      // coincidir con el identificador que Mia usa en su campo "imagenes".
      images: {
        foto_sede: process.env.MIA_IMG_FOTO_SEDE || null,
      },
      // Recontacto (follow-up automático de leads fríos). Apagado por defecto:
      // solo manda WhatsApps si MIA_RECONTACTO_ENABLED=true. Las imágenes son
      // una lista de URLs públicas separadas por coma (Mia las rota del 2º toque
      // en adelante).
      recontacto: {
        enabled: process.env.MIA_RECONTACTO_ENABLED === 'true',
        images: (process.env.MIA_RECONTACTO_IMG_URLS || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
      },
      // Recordatorios de cita (día antes + mismo día). Apagado por defecto:
      // solo manda WhatsApps si MIA_RECORDATORIOS_ENABLED=true.
      recordatorios: {
        enabled: process.env.MIA_RECORDATORIOS_ENABLED === 'true',
      },
    };
  })(),
};
