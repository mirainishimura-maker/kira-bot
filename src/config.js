import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta variable de entorno: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  env: process.env.NODE_ENV ?? 'development',
  tz: process.env.TZ ?? 'America/Lima',

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  evolution: {
    url: required('EVOLUTION_API_URL'),
    apiKey: required('EVOLUTION_API_KEY'),
    instance: required('EVOLUTION_INSTANCE_NAME'),
    // GROUP_JID se captura automáticamente al recibir el primer mensaje del grupo.
    groupJid: process.env.GROUP_JID || null,
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
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
    return {
      enabled: Boolean(url && key && aiKey && personal),
      supabase: { url, serviceRoleKey: key },
      openai:   { apiKey: aiKey, model: process.env.MIRAI_OPENAI_MODEL || 'gpt-4o-mini' },
      personalPhone: personal,
      // Default 0: Mia continúa de inmediato después del saludo manual de Mirai.
      // Si en el futuro quieres que se quede callada un rato tras tus mensajes
      // manuales, sube este valor con la env var MIA_SILENCE_AFTER_MIRAI_MINUTES.
      silenceAfterMiraiMinutes: Number(process.env.MIA_SILENCE_AFTER_MIRAI_MINUTES ?? 0),
    };
  })(),
};
