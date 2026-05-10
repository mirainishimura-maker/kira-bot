import express from 'express';
import { config } from './config.js';
import { handleWebhook } from './webhook/evolution.js';
import { startCrons } from './services/crons.js';
import { runBirthdayCron } from './services/birthdays.js';
import { runMiraiOpsCron } from './services/ops.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'kira-bot', env: config.env });
});

app.post('/webhook', handleWebhook);

// Trigger manual de crons. Protegido por WEBHOOK_SECRET (header x-admin-secret).
// Útil para probar sin esperar a las 7/8 AM y para volver a disparar si falló.
app.post('/admin/cron/:name', async (req, res) => {
  if (!config.webhookSecret || req.header('x-admin-secret') !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    let result;
    if (req.params.name === 'birthdays')      result = await runBirthdayCron();
    else if (req.params.name === 'mirai_ops') result = await runMiraiOpsCron();
    else return res.status(404).json({ ok: false, error: 'unknown cron' });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[admin] cron falló:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`[kira] escuchando en :${config.port} (${config.env}, TZ=${config.tz})`);
  startCrons();
});
