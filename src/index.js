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
import { startBriefCron, runBriefMatutino } from './services/mia/briefMatutino.js';
import { startGdhRecapCron, runGdhRecap } from './services/mia/gdhRecap.js';
import { startResumenFinanzasCron, runResumenFinanzas } from './services/mia/resumenFinanzas.js';
import { startSesionPrepCron, runSesionPrep } from './services/mia/sesionPrep.js';
import { startAgendaSyncCron, runAgendaSync } from './services/mia/agendaSync.js';
import { startCitasSyncCron, runCitasSync } from './services/mia/citasSync.js';
import { startGenteCron, runGenteCheck } from './services/mia/gente.js';
import { startPagosCron, runPagosRecordatorio } from './services/mia/pagosFijos.js';
import { runMetricas } from './services/mia/metricas.js';
import { runImperio } from './services/mia/imperio.js';
import { startNeuraCron, runNeuraSweep } from './services/neura/publisher.js';
import { startItacaPRCron, chequearPRs } from './services/mia/itacaCorrecciones.js';
import { presionarBoton } from './services/pieroBoton.js';

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

// Brief matutino de Mia a Mirai (agenda + pendientes de hoy): dry por defecto
// (muestra el texto sin enviar). ?dry=false lo envía YA. Protegido por WEBHOOK_SECRET.
app.post('/admin/brief', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try {
    res.json(await runBriefMatutino({ dry }));
  } catch (err) {
    console.error('[admin/brief] falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Recap del grupo GDH (Claude resume la conversación del día): dry por defecto
// (muestra el texto sin enviar). ?dry=false lo envía a Mirai. Protegido por WEBHOOK_SECRET.
app.post('/admin/gdh', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try {
    res.json(await runGdhRecap({ dry }));
  } catch (err) {
    console.error('[admin/gdh] falló:', err);
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

// Reporte de imperio (routine cloud de los lunes): agregados de pagos de los
// últimos 7 días. Solo números, sin datos de pacientes. Protegido por WEBHOOK_SECRET.
app.post('/admin/imperio', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  try { res.json(await runImperio()); }
  catch (err) { console.error('[admin/imperio] falló:', err); res.status(500).json({ ok: false, error: err.message }); }
});

// Resumen de plata ("¿en qué se me fue?"): dry por defecto; ?dry=false lo envía.
app.post('/admin/finanzas', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try { res.json(await runResumenFinanzas({ dry })); }
  catch (err) { console.error('[admin/finanzas] falló:', err); res.status(500).json({ ok: false, error: err.message }); }
});

// Preparación de sesión (recap del paciente antes de la cita): dry por defecto.
app.post('/admin/prep', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try { res.json(await runSesionPrep({ dry })); }
  catch (err) { console.error('[admin/prep] falló:', err); res.status(500).json({ ok: false, error: err.message }); }
});

// Sincroniza el Google Calendar al panel (tabla agenda_cache). ?dry no aplica;
// siempre reescribe el snapshot. Protegido por WEBHOOK_SECRET.
app.post('/admin/agenda-sync', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  try { res.json(await runAgendaSync()); }
  catch (err) { console.error('[admin/agenda-sync] falló:', err); res.status(500).json({ ok: false, error: err.message }); }
});

// Empuja las citas del panel/reservas web al Google Calendar (normalmente
// corre cada 3 min). Protegido por WEBHOOK_SECRET.
app.post('/admin/citas-sync', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  try { res.json(await runCitasSync()); }
  catch (err) { console.error('[admin/citas-sync] falló:', err); res.status(500).json({ ok: false, error: err.message }); }
});

// Recordatorio de pagos/suscripciones que vencen hoy/mañana (dry por defecto).
app.post('/admin/pagos', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const dry = req.query.send !== '1';
  try { res.json(await runPagosRecordatorio({ dry })); }
  catch (err) { console.error('[admin/pagos] falló:', err); res.status(500).json({ ok: false, error: err.message }); }
});

// Cuidar tus vínculos (cumpleaños + con quién llevas rato sin hablar): dry por
// defecto (muestra el texto); ?dry=false lo envía. Protegido por WEBHOOK_SECRET.
app.post('/admin/gente', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  const dry = !(req.query.dry === 'false' || req.query.dry === '0');
  try { res.json(await runGenteCheck({ dry })); }
  catch (err) { console.error('[admin/gente] falló:', err); res.status(500).json({ ok: false, error: err.message }); }
});

// ITACA · fuerza el chequeo de PRs de las correcciones (normalmente corre cada
// 3 min). Útil para no esperar al cron cuando acabas de aprobar/mergear un PR.
app.post('/admin/itaca-prs', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(400).json({ ok: false, error: 'Mia no habilitada' });
  try { res.json(await chequearPRs()); }
  catch (err) { console.error('[admin/itaca-prs] falló:', err); res.status(500).json({ ok: false, error: err.message }); }
});

// Botón de Piero: el Atajo de su iPhone hace POST aquí (token propio en ?t= o
// header x-piero-token — nunca el secreto admin) → Mirai recibe el "está
// pensando en ti" por WhatsApp y el Atajo le muestra a Piero la respuesta.
// Con ?plain=1 responde texto plano (más fácil de mostrar en Atajos).
// Apagado (404) mientras no exista PIERO_BOTON_TOKEN.
app.post('/piero/boton', async (req, res) => {
  if (!config.piero.botonToken) return res.status(404).json({ ok: false });
  const token = req.query.t || req.header('x-piero-token');
  if (token !== config.piero.botonToken) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!config.mia.enabled) return res.status(503).json({ ok: false, error: 'Mia no habilitada' });
  const plain = req.query.plain === '1' || req.query.plain === 'true';
  try {
    const result = await presionarBoton();
    if (plain) return res.type('text/plain').send(result.mensaje);
    res.json(result);
  } catch (err) {
    console.error('[piero/boton] falló:', err);
    if (plain) return res.status(500).type('text/plain').send('Ups, no le pude avisar 😅 intenta de nuevo en un toque.');
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
    startBriefCron();
    startGdhRecapCron();
    startResumenFinanzasCron();
    startSesionPrepCron();
    startAgendaSyncCron();
    startCitasSyncCron();
    startGenteCron();
    startPagosCron();
    startItacaPRCron();
  }
  // NEURA (publicador de Instagram) — independiente de Mia, se auto-gatea.
  startNeuraCron();
});
