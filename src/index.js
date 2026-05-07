import express from 'express';
import { config } from './config.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'kira-bot', env: config.env });
});

// TODO Fase 2: webhook handler de Evolution API
app.post('/webhook', (_req, res) => {
  res.status(202).json({ received: true });
});

app.listen(config.port, () => {
  console.log(`[kira] escuchando en :${config.port} (${config.env}, TZ=${config.tz})`);
});
