// Schedules de KIRA con node-cron. Todos los crons corren en America/Lima.
//
//   07:00  → runBirthdayCron()  — cumples de los 3 espacios birthday_reminders.
//   08:00  → runMiraiOpsCron()  — resumen de tareas pendientes de mirai_ops.

import cron from 'node-cron';
import { runBirthdayCron } from './birthdays.js';
import { runMiraiOpsCron } from './ops.js';

const TZ = 'America/Lima';

export function startCrons() {
  cron.schedule('0 7 * * *', async () => {
    try { await runBirthdayCron(); }
    catch (err) { console.error('[cron] birthdays falló:', err); }
  }, { timezone: TZ });

  cron.schedule('0 8 * * *', async () => {
    try { await runMiraiOpsCron(); }
    catch (err) { console.error('[cron] mirai_ops falló:', err); }
  }, { timezone: TZ });

  console.log(`[cron] schedules activos | TZ=${TZ} | 07:00 birthdays | 08:00 mirai_ops`);
}
