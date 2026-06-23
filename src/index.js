import express from 'express';
import { config } from './config.js';
import { handleWebhook } from './webhook/evolution.js';
import { startCrons } from './services/crons.js';
import { runBirthdayCron } from './services/birthdays.js';
import { runMiraiOpsCron } from './services/ops.js';
import { findMemberByPhone } from './services/members.js';
import { getMemberSpaceSlugs } from './services/spaces.js';
import { ask } from './services/ai.js';
import { startRecontactoCron, runRecontactoSweep } from './services/mia/recontacto.js';
import { startRecordatoriosCron, runRecordatoriosSweep } from './services/mia/recordatorios.js';
import { startResenasCron, runResenasSweep } from './services/mia/resenas.js';
import { startResumenCron, runResumenDiario } from './services/mia/resumenDiario.js';
import { runMetricas } from './services/mia/metricas.js';
import { startNeuraCron, runNeuraSweep } from './services/neura/publisher.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'kira-bot',
    mode: config.miaOnly ? 'mia-only' : 'full',
    miaEnabled: config.mia.enabled,
    miaModel: config.mia.openai.model,
    recontacto: config.mia.recontacto.enabled,
    recordatorios: config.mia.recordatorios.enabled,
    resenas: config.mia.resenas.enabled,
    env: config.env,
  });
});

app.post('/webhook', handleWebhook);

// Trigger manual de crons. Protegido por WEBHOOK_SECRET (header x-admin-secret).
// Útil para probar sin esperar a las 7/8 AM y para volver a disparar si falló.
// Query param ?dry=true → formatea y loguea pero NO envía mensajes reales.
app.post('/admin/cron/:name', async (req, res) => {
  if (config.miaOnly) return res.status(404).json({ ok: false, error: 'crons de KIRA-mkt desactivados en modo Mia-only' });
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const dry = req.query.dry === 'true' || req.query.dry === '1';
  try {
    let result;
    if (req.params.name === 'birthdays')      result = await runBirthdayCron({ dry });
    else if (req.params.name === 'mirai_ops') result = await runMiraiOpsCron({ dry });
    else return res.status(404).json({ ok: false, error: 'unknown cron' });
    res.json({ ok: true, dry, result });
  } catch (err) {
    console.error('[admin] cron falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Simula una conversación con KIRA sin pasar por WhatsApp/Evolution.
// Body: { phone, message, channel? }. Devuelve el JSON crudo que produjo GPT
// (messages/actions/alerts). NO envía mensajes reales ni guarda en memoria.
// Las tools que escriben en hojas SÍ se ejecutan (mirai_ops append/update).
app.post('/admin/ask', async (req, res) => {
  if (config.miaOnly) return res.status(404).json({ ok: false, error: 'KIRA-mkt desactivado en modo Mia-only' });
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { phone, message, channel = 'private' } = req.body ?? {};
  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: 'faltan phone o message' });
  }
  try {
    const member = await findMemberByPhone(phone);
    if (!member) return res.status(404).json({ ok: false, error: `no hay miembro con phone=${phone}` });
    const memberSpaces = await getMemberSpaceSlugs(member.id);
    const spaceSlug = (channel === 'private' && memberSpaces.includes('mirai_ops'))
      ? 'mirai_ops'
      : 'mkt';
    const result = await ask({
      member,
      channel,
      message,
      context: { activeTasks: [], recentMemory: [], spaceSlug },
    });
    res.json({ ok: true, member: { name: member.name, role: member.role }, memberSpaces, spaceSlug, result });
  } catch (err) {
    console.error('[admin/ask] falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Guard de arranque: si pediste MIA_ONLY pero faltan las credenciales de Mia,
// el proceso no tiene nada que hacer — abortamos con un mensaje claro.
if (config.miaOnly && !config.mia.enabled) {
  console.error('[kira] MIA_ONLY=true pero Mia no está habilitada: faltan MIRAI_SUPABASE_URL, MIRAI_SUPABASE_SERVICE_ROLE_KEY, MIRAI_OPENAI_API_KEY o MIRAI_PERSONAL_PHONE.');
  process.exit(1);
}

// Recontacto de Mia: dry-run por defecto (calcula a quién contactaría sin
// enviar). ?dry=false envía DE VERDAD, pero solo si MIA_RECONTACTO_ENABLED=true.
// Funciona también en modo Mia-only. Protegido por WEBHOOK_SECRET.
app.post('/admin/recontacto', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0'); // dry por defecto
  try {
    const result = await runRecontactoSweep({ dry });
    res.json(result);
  } catch (err) {
    console.error('[admin/recontacto] falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Recordatorios de cita: dry-run por defecto. ?dry=false envía (solo si
// MIA_RECORDATORIOS_ENABLED=true). Protegido por WEBHOOK_SECRET.
app.post('/admin/recordatorios', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try {
    const result = await runRecordatoriosSweep({ dry });
    res.json(result);
  } catch (err) {
    console.error('[admin/recordatorios] falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reseñas post-sesión: dry-run por defecto. ?dry=false envía (solo si
// MIA_RESENA_ENABLED=true y hay MIA_RESENA_URL). Protegido por WEBHOOK_SECRET.
app.post('/admin/resenas', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try {
    const result = await runResenasSweep({ dry });
    res.json(result);
  } catch (err) {
    console.error('[admin/resenas] falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// NEURA: publicar el próximo de la cola a Instagram. dry por defecto (solo
// muestra cuál sigue). ?dry=false publica YA. Protegido por WEBHOOK_SECRET.
app.post('/admin/neura', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try {
    const result = await runNeuraSweep({ dry });
    res.json(result);
  } catch (err) {
    console.error('[admin/neura] falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Resumen diario de Mia a Mirai: dry por defecto (muestra el texto sin enviar).
// ?dry=false lo envía YA al WhatsApp de Mirai. Protegido por WEBHOOK_SECRET.
app.post('/admin/resumen', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try {
    res.json(await runResumenDiario({ dry }));
  } catch (err) {
    console.error('[admin/resumen] falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Métricas del embudo (IG + leads + conversión). dry por defecto (muestra texto);
// ?dry=false lo envía al WhatsApp de Mirai. Protegido por WEBHOOK_SECRET.
app.post('/admin/metricas', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try {
    res.json(await runMetricas({ dry }));
  } catch (err) {
    console.error('[admin/metricas] falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(config.port, () => {
  const mode = config.miaOnly ? 'MIA-ONLY (sin KIRA-mkt)' : 'completo (KIRA-mkt + Mia)';
  console.log(`[kira] escuchando en :${config.port} (${config.env}, TZ=${config.tz}) | modo: ${mode}`);
  // Los crons (cumpleaños, mirai_ops) son de KIRA-mkt — no corren en modo Mia-only.
  if (config.miaOnly) {
    console.log('[kira] modo Mia-only: crons de KIRA-mkt desactivados.');
  } else {
    startCrons();
  }
  // Crons de Mia (corren también en modo Mia-only).
  if (config.mia.enabled) {
    startRecontactoCron();
    startRecordatoriosCron();
    startResenasCron();
    startResumenCron();
  }
  // NEURA (publicador de Instagram) — independiente de Mia, se auto-gatea.
  startNeuraCron();
});
