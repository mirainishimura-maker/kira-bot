import express from 'express';
import { config } from './config.js';
import { handleWebhook } from './webhook/evolution.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'kira-bot', env: config.env });
});

app.post('/webhook', handleWebhook);

app.listen(config.port, () => {
  console.log(`[kira] escuchando en :${config.port} (${config.env}, TZ=${config.tz})`);
});
