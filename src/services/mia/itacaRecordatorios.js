// ITACA · Recordatorios de cita, disparados desde la nube.
//
// Los recordatorios de WhatsApp que Itaca le manda a sus pacientes los venía
// disparando una Tarea programada en la computadora de Mirai. Si ese día estaba
// apagada, nadie recibía su recordatorio y las faltas subían sin que se
// enterara nadie hasta que un paciente no llegaba.
//
// Este cron llama al endpoint de Itaca cada mañana. Itaca hace el trabajo (elige
// las citas, arma el texto, envía y deja bitácora); acá solo se aprieta el
// botón y se avisa a Mirai si algo salió mal.
//
// Es seguro que convivan los dos disparadores: Itaca solo toma las citas que
// aún no fueron recordadas, así que quien llegue segundo no encuentra nada que
// mandar. Ningún paciente recibe el mensaje dos veces.
//
// Apagado hasta que estén ITACA_API_URL e ITACA_INTEGRACION_TOKEN.

import cron from 'node-cron';
import { config } from '../../config.js';
import { sendText } from '../../lib/evolution.js';
import { rememberMiaSentId } from './echoTracker.js';

const TZ = 'America/Lima';

async function avisarMirai(text) {
  try {
    const sent = await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, text);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  } catch (e) {
    console.error('[itaca/recordatorios] no pude avisar a Mirai:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Llama a Itaca. Devuelve el resumen {enviados, fallidos, omitidos, detalle}.
// ---------------------------------------------------------------------------
export async function dispararRecordatorios({ dry = false, fecha = null } = {}) {
  const { apiUrl, token } = config.mia.itaca;
  if (!apiUrl || !token) {
    return { ok: false, error: 'Falta ITACA_API_URL o ITACA_INTEGRACION_TOKEN.' };
  }

  const url = `${apiUrl.replace(/\/$/, '')}/api/integraciones/recordatorios/`;
  const body = {};
  if (dry) body.dry = true;
  if (fecha) body.fecha = fecha;

  // 60s: el envío es secuencial y puede haber varias decenas de citas.
  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Integracion-Token': token },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const texto = await r.text();
    if (!r.ok) {
      // 403 casi siempre es el token: o no está en Railway, o no coincide.
      const pista = r.status === 403
        ? ' (el token no coincide con el que tiene Itaca en Railway)'
        : '';
      return { ok: false, error: `Itaca respondió ${r.status}${pista}: ${texto.slice(0, 200)}` };
    }
    return { ok: true, ...JSON.parse(texto) };
  } catch (e) {
    const error = e.name === 'AbortError' ? 'Itaca no respondió en 60s.' : e.message;
    return { ok: false, error };
  } finally {
    clearTimeout(corte);
  }
}

// ---------------------------------------------------------------------------
// El barrido de la mañana. Solo escribe a Mirai cuando hay algo que hacer:
// si todo salió bien, no la molesta.
// ---------------------------------------------------------------------------
export async function runRecordatoriosItaca({ dry = false } = {}) {
  const res = await dispararRecordatorios({ dry });

  if (!res.ok) {
    console.error('[itaca/recordatorios]', res.error);
    await avisarMirai(
      `⚠️ *Los recordatorios de Itaca no salieron hoy.*\n\n${res.error}\n\n` +
      'Las coordinadoras pueden mandarlos a mano desde la agenda, con «Mensaje». ' +
      'El panel de inicio también lo avisa a partir de las 9.'
    );
    return res;
  }

  const { enviados = 0, fallidos = 0, omitidos = 0 } = res;
  console.log(`[itaca/recordatorios] enviados=${enviados} fallidos=${fallidos} omitidos=${omitidos}`);

  if (fallidos > 0) {
    const quienes = (res.detalle || [])
      .filter((d) => d.estado === 'falló')
      .slice(0, 8)
      .map((d) => `• ${d.paciente} (${d.hora}) — ${d.motivo || ''}`)
      .join('\n');
    await avisarMirai(
      `⚠️ *Recordatorios de Itaca:* salieron ${enviados}, pero ${fallidos} no.\n\n${quienes}\n\n` +
      'Suele ser el WhatsApp desconectado. Esas citas quedan sin marcar, así que ' +
      'si se arregla y se vuelve a correr, se reintentan solas.'
    );
  }
  return res;
}

export function startItacaRecordatoriosCron() {
  const { apiUrl, token } = config.mia.itaca;
  if (!apiUrl || !token) {
    console.log('[itaca/recordatorios] cron NO iniciado (falta ITACA_API_URL o ITACA_INTEGRACION_TOKEN).');
    return;
  }
  // 7:30 — con margen antes de las 9, que es cuando el panel de Itaca empieza a
  // avisar que las citas del día siguen sin recordatorio.
  cron.schedule('30 7 * * *', () => {
    runRecordatoriosItaca({ dry: false })
      .catch((e) => console.error('[itaca/recordatorios] barrido falló:', e.message));
  }, { timezone: TZ });
  console.log(`[itaca/recordatorios] cron activo | 7:30 ${TZ}`);
}
