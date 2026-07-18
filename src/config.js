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
    // Clínicas que REFIEREN leads (reenvían números de interesados). Cualquier
    // mensaje de estos números con un teléfono adentro = referido: Mia registra
    // al lead y le manda el saludo. Default Mont Sinai, sin depender de EasyPanel.
    const referrerPhones = [
      ...(process.env.MIA_REFERRER_PHONES || '').split(',').map(s => s.trim()).filter(Boolean),
      '51941697769', // Clínica Mont Sinai
    ];
    // WhatsApp migró algunas identidades a @lid (IDs opacos que NO son el número).
    // Cuando los mensajes de Mirai llegan como @lid, el bot no la reconocía por su
    // número. Aquí registramos su(s) @lid conocido(s) para volver a identificarla.
    const personalLids = (process.env.MIRAI_PERSONAL_LID || '158807137218784')
      .split(',').map(s => s.trim()).filter(Boolean);
    return {
      enabled: Boolean(url && key && aiKey && personal),
      supabase: { url, serviceRoleKey: key },
      openai:   { apiKey: aiKey, model: process.env.MIRAI_OPENAI_MODEL || 'gpt-4o-mini' },
      personalPhone: personal,
      personalLids,
      operatorPhones,
      referrerPhones,
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
      // Control por STICKERS: Mirai manda un sticker a un paciente para que Mia
      // deje de responderle, y otro para reactivarla. Los hashes se capturan en
      // runtime (/sticker parar|retomar) y se guardan en data/mia-stickers.json;
      // estas env vars los fijan permanentes (sobreviven a redeploys sin volumen).
      stickers: {
        stop:   process.env.MIA_STICKER_STOP   || null,
        resume: process.env.MIA_STICKER_RESUME || null,
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
      // NEURA — asistente personal de Mirai por voz/texto natural (Fase 1).
      // Apagado por defecto: el webhook solo intercepta los mensajes de Mirai
      // (para registrar gasto / recordatorio / consultar agenda) si
      // NEURA_ASSISTANT_ENABLED=true. Sin el flag, cero cambios de comportamiento.
      assistant: {
        enabled: process.env.NEURA_ASSISTANT_ENABLED === 'true',
        // Mia responde también por nota de voz en las respuestas conversacionales
        // (reflexión, resumen de plata, recap GDH). Apagar con NEURA_VOICE_REPLIES=false.
        voiceReplies: process.env.NEURA_VOICE_REPLIES !== 'false',
      },
      // Cerebro Claude (Anthropic) — Fase 2 de Neura (recap de GDH, reportes,
      // reflexión). Sin la key, esas features degradan y avisan.
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      // Grupo de trabajo GDH que Neura observa (MUDO) para el recap diario.
      // Default = "GDH - Ítaca HUB"; override con MIA_GDH_GROUP_JID.
      gdhGroupJid: process.env.MIA_GDH_GROUP_JID || '120363357978846743@g.us',
      // Pago esperado para confirmar una cita (verificación del comprobante).
      // Defaults = primera consulta a Yape/Plin de Mirai. Configurable por env.
      pago: {
        monto:  Number(process.env.MIA_PAGO_MONTO || 75),
        numero: (process.env.MIA_PAGO_NUMERO || '977668497').replace(/\D/g, ''),
        nombre: process.env.MIA_PAGO_NOMBRE || 'Mirai Nishimura',
      },
      // Pedir un TESTIMONIO anónimo tras la sesión (no usa link de Google).
      // Encendido por defecto; se apaga solo con MIA_RESENA_ENABLED='false'.
      resenas: {
        enabled: process.env.MIA_RESENA_ENABLED !== 'false',
      },
      // Lead magnet (guía gratis en PDF) que Mia envía cuando un lead la pide.
      // URL pública por defecto (no secreta) → no depende de setear env en EasyPanel.
      guia: {
        url: process.env.MIA_GUIA_URL || 'https://bnhurojxksuvdgraocoh.supabase.co/storage/v1/object/public/neura/guias/calma-tu-ansiedad.pdf',
        nombre: process.env.MIA_GUIA_NOMBRE || 'NEURA · Calma tu ansiedad.pdf',
      },
      // ITACA · Correcciones desde el grupo "conversemos las tres". Mia LEE ese
      // grupo en silencio (nunca postea ahí), digiere cada corrección y se la
      // manda a Mirai a su privado. Con /ok N abre un issue en GitHub que la
      // GitHub Action de Claude implementa en una rama + PR (nunca toca prod
      // sin que Mirai apruebe el PR). Todo apagado hasta setear ITACA_GROUP_JID.
      itaca: {
        // JID del grupo (formato 120363xxx@g.us). Descúbrelo con /grupos.
        groupJid: process.env.ITACA_GROUP_JID || null,
        enabled: Boolean(process.env.ITACA_GROUP_JID),
        // Repo donde vive el sistema y token para abrir issues.
        repo: process.env.ITACA_REPO || 'conversemositaca-tech/itaca-conversemos',
        githubToken: process.env.GITHUB_TOKEN || '',
        // Debounce para agrupar varios mensajes seguidos de la misma persona
        // (ej: 3 audios que son una sola corrección). Default 60s.
        debounceMs: (() => {
          const n = Number(process.env.ITACA_DEBOUNCE_MS);
          return Number.isFinite(n) && n > 0 ? n : 60_000;
        })(),
      },
    };
  })(),

  // NEURA — publicador automático del Instagram @neurapsi2026 (marca anónima de
  // marketing para captar leads a Mia). Separado de Mia. Apagado salvo que esté
  // configurado. Reusa el Supabase de Mirai (mismas credenciales MIRAI_*) para
  // hostear imágenes y persistir la cola + el token (que se refresca solo).
  neura: {
    // Encendido por DEFECTO: el publicador se auto-gatea con el token que vive en
    // el bucket privado, así que no depende de setear NEURA_ENABLED en EasyPanel.
    // Solo se apaga si explícitamente NEURA_ENABLED='false'.
    enabled: process.env.NEURA_ENABLED !== 'false',
    // IG user de @neurapsi2026 (no es secreto); default por si falta el env.
    igUserId: process.env.NEURA_IG_USER_ID || '17841423773440647',
    igTokenSeed: process.env.NEURA_IG_TOKEN || '', // token inicial; luego se refresca y persiste en el bucket privado
    bucket: process.env.NEURA_BUCKET || 'neura',           // PÚBLICO — solo imágenes
    stateBucket: process.env.NEURA_STATE_BUCKET || 'neura-state', // PRIVADO — token + cola
    // Horas (Lima) en que publica. Default 5/día (modo vaciado de backlog).
    // Coma-separadas. Override con NEURA_HORAS.
    horas: (process.env.NEURA_HORAS || '9,12,15,18,21')
      .split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 0 && n < 24),
    // Portada del reel: ms del frame que IG usa como portada. Los reels arrancan
    // con un fade-in desde negro (~0.5s), así que el frame 0 es negro feo. 2500ms
    // cae en zona ya visible. Si un item trae `cover` (URL de imagen), esa gana.
    reelThumbMs: Number(process.env.NEURA_REEL_THUMB_MS || 2500),
    // Stories: re-compartir cada publicación del feed a una story (default ON).
    reshareStory: process.env.NEURA_RESHARE_STORY !== 'false',
    // Hora (Lima) de la story "frase del día" (cola state.stories). 0 = desactivar.
    storyHora: Number(process.env.NEURA_STORY_HORA || 11),
  },
};
