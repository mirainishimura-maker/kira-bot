// ITACA · Correcciones desde el grupo "conversemos las tres".
//
// Mia LEE ese grupo en SILENCIO (nunca postea ahí). Cada mensaje —texto, audio
// (Whisper) o imagen/captura (visión)— lo digiere, lo clasifica con Claude
// (corrección / pregunta / ruido) y se lo manda a Mirai a su privado.
//
// Flujo semi-automático con PR (aprobado por Mirai):
//   1. Corrección detectada  → ticket 'pendiente' + aviso a Mirai.
//   2. Mirai responde /ok N   → Mia abre un issue en GitHub etiquetando @claude.
//   3. La GitHub Action de Claude implementa en una RAMA y abre un PR.
//   4. Cron detecta el PR     → avisa a Mirai el link para que lo revise/apruebe.
//   5. Mirai hace merge (cel) → Railway despliega; el cron detecta el merge y
//      avisa a Mirai: "listo, en producción, dile a quien la pidió que revise".
//
// Nada llega a producción sin que Mirai apruebe el PR. Todo apagado hasta setear
// ITACA_GROUP_JID (config.mia.itaca.enabled).

import cron from 'node-cron';
import { anthropic, CLAUDE_MODEL } from '../../lib/anthropic.js';
import { miraiSupabase } from '../../lib/miraiSupabase.js';
import { miraiOpenai, MIA_MODEL } from '../../lib/miraiOpenai.js';
import { sendText, fetchMessageMediaBase64 } from '../../lib/evolution.js';
import { transcribeAudio } from './media.js';
import { rememberMiaSentId } from './echoTracker.js';
import { createIssue, findLinkedPR, getPR, githubReady, findClaudeBranch, createPR } from '../../lib/github.js';
import { config } from '../../config.js';

const TABLE = 'itaca_correcciones';

// ---------------------------------------------------------------------------
// Aviso a Mirai (privado). Marca el id para que el echoTracker no lo confunda
// con un mensaje manual de Mirai a un paciente.
// ---------------------------------------------------------------------------
async function avisarMirai(text) {
  try {
    const sent = await sendText(`${config.mia.personalPhone}@s.whatsapp.net`, text);
    if (sent?.key?.id) rememberMiaSentId(sent.key.id);
  } catch (e) {
    console.error('[itaca] no pude avisar a Mirai:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Multimedia → texto
// ---------------------------------------------------------------------------
async function mensajeATexto(data) {
  const m = data?.message;
  if (!m) return null;

  const text = m.conversation ?? m.extendedTextMessage?.text ?? null;
  if (text) return text;

  if (m.imageMessage) {
    const caption = m.imageMessage.caption ?? '';
    const media = await fetchMessageMediaBase64(data);
    if (media?.base64) {
      const desc = await describirImagen({ base64: media.base64, mimetype: media.mimetype, caption });
      if (desc) return `[imagen/captura] ${desc}`;
    }
    return caption ? `[imagen] ${caption}` : null;
  }

  if (m.audioMessage) {
    const media = await fetchMessageMediaBase64(data);
    if (media?.base64) {
      const txt = await transcribeAudio({ base64: media.base64, mimetype: media.mimetype });
      if (txt) return txt;
    }
    return null;
  }

  if (m.videoMessage)    return m.videoMessage.caption ? `[video] ${m.videoMessage.caption}` : null;
  if (m.documentMessage) return m.documentMessage.caption ? `[documento] ${m.documentMessage.caption}` : null;
  return null;
}

// Describe una imagen (captura del sistema, boceto o referencia) de forma útil
// para un programador. Usa la cuenta de OpenAI de Mirai (visión).
async function describirImagen({ base64, mimetype = 'image/jpeg', caption = '' }) {
  if (!miraiOpenai || !base64) return caption || null;
  const dataUrl = `data:${mimetype};base64,${base64}`;
  const hint = caption ? `Quien la envió escribió: "${caption}". ` : '';
  const instruccion = `${hint}Esta imagen es parte de una CORRECCIÓN a un sistema web (app de gestión de una clínica). Puede ser una captura de pantalla del sistema, un boceto/mockup o una referencia de diseño. Describe con detalle y de forma ÚTIL para un programador QUÉ se ve y QUÉ cambio parece pedirse: pantalla o sección, elementos (botones, campos, tablas, textos exactos), colores y cualquier flecha/marca/anotación. Sé concreto. 2 a 5 oraciones.`;
  try {
    const r = await miraiOpenai.chat.completions.create({
      model: MIA_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruccion },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 500,
      temperature: 0.2,
    });
    return (r.choices?.[0]?.message?.content ?? '').trim() || caption || null;
  } catch (e) {
    console.error('[itaca] describirImagen error:', e.message);
    return caption || null;
  }
}

// ---------------------------------------------------------------------------
// Debounce por persona: agrupa varios mensajes seguidos (ej. 3 audios que son
// una sola corrección) antes de clasificar.
// ---------------------------------------------------------------------------
const buffers = new Map(); // key(participant) -> { autor, items:[], seenIds:Set, timer }

export async function handleItacaGroupMessage(data) {
  if (!config.mia.itaca?.enabled) return;
  const messageId = data?.key?.id ?? null;
  const autor = data?.pushName || 'alguien del grupo';
  const key = data?.key?.participant || data?.key?.participantPn || data?.participantPn || autor;

  const texto = await mensajeATexto(data);
  if (!texto || !texto.trim()) return;

  let buf = buffers.get(key);
  if (!buf) {
    buf = { autor, items: [], seenIds: new Set(), timer: null };
    buffers.set(key, buf);
  }
  if (messageId && buf.seenIds.has(messageId)) return; // dedup
  if (messageId) buf.seenIds.add(messageId);
  buf.autor = autor;
  buf.items.push(texto);

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flush(key), config.mia.itaca.debounceMs);
  console.log(`[itaca] mensaje de "${autor}" en el grupo (buffer=${buf.items.length})`);
}

async function flush(key) {
  const buf = buffers.get(key);
  if (!buf) return;
  buffers.delete(key);
  const contenido = buf.items.join('\n');
  try {
    await procesarMensajes(buf.autor, contenido);
  } catch (e) {
    console.error('[itaca] procesarMensajes error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Clasificación con Claude
// ---------------------------------------------------------------------------
async function procesarMensajes(autor, contenido) {
  const clas = await clasificar(autor, contenido);
  if (!clas) return;

  if (clas.tipo === 'correccion') {
    const ticket = await crearTicket({ autor, titulo: clas.titulo, detalle: clas.detalle });
    if (!ticket) {
      await avisarMirai(`⚠️ Detecté una corrección de ${autor} pero no pude guardarla. Revisa que exista la tabla *${TABLE}* en Supabase.\n\nEl pedido era:\n"${contenido.slice(0, 500)}"`);
      return;
    }
    await avisarMirai(formatoNuevaCorreccion(ticket));
  } else if (clas.tipo === 'pregunta') {
    await avisarMirai(`❓ *Pregunta en el grupo* — de ${autor}:\n"${clas.detalle || contenido}"\n\n(Mia está muda en el grupo; respóndele tú 🌸)`);
  } else {
    console.log(`[itaca] mensaje de "${autor}" clasificado como ruido, ignorado.`);
  }
}

async function clasificar(autor, contenido) {
  // Sin cerebro Claude: no perdemos el pedido, lo tratamos como corrección cruda.
  if (!anthropic) {
    return { tipo: 'correccion', titulo: contenido.slice(0, 60), detalle: contenido };
  }
  const system = `Eres el filtro de Mia. En un grupo de WhatsApp, el equipo le manda a Mirai correcciones y pedidos sobre un SISTEMA WEB que ella construye (app de gestión de una clínica: pacientes, citas, notas clínicas, finanzas, envío de WhatsApp). Clasifica el mensaje del equipo.

Responde SOLO con JSON válido, sin texto extra:
{
  "tipo": "correccion" | "pregunta" | "ruido",
  "titulo": "<título corto y accionable del cambio, en imperativo, máx 70 caracteres>",
  "detalle": "<el pedido reescrito claro y COMPLETO para pasárselo a un programador; conserva TODOS los datos concretos: nombres de pantallas/secciones, campos, textos exactos entre comillas, colores. Si el mensaje trae una imagen descrita entre corchetes, intégrala en el detalle.>"
}

Reglas:
- "correccion": pide agregar, cambiar, quitar o arreglar algo del sistema.
- "pregunta": preguntan algo (cómo va, un estado, una duda) sin pedir un cambio.
- "ruido": saludos, agradecimientos, confirmaciones o coordinación que NO es un cambio ("ok", "gracias", "buenos días", "ya vi").
- No inventes cambios que no están. Si dudas entre "correccion" y "ruido", elige "ruido".`;
  try {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: `Mensaje de ${autor}:\n\n${contenido}` }],
    });
    const raw = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const clean = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const json = JSON.parse(clean);
    const tipo = ['correccion', 'pregunta', 'ruido'].includes(json.tipo) ? json.tipo : 'ruido';
    return {
      tipo,
      titulo: String(json.titulo ?? '').trim().slice(0, 70) || contenido.slice(0, 60),
      detalle: String(json.detalle ?? contenido).trim(),
    };
  } catch (e) {
    console.error('[itaca] clasificar error:', e.message);
    // Ante error de formato: no perdemos el pedido.
    return { tipo: 'correccion', titulo: contenido.slice(0, 60), detalle: contenido };
  }
}

// ---------------------------------------------------------------------------
// Persistencia (Supabase privado de Mirai)
// ---------------------------------------------------------------------------
async function crearTicket({ autor, titulo, detalle }) {
  if (!miraiSupabase) return null;
  const { data, error } = await miraiSupabase
    .from(TABLE)
    .insert({ autor, titulo, detalle, estado: 'pendiente' })
    .select()
    .single();
  if (error) { console.error('[itaca] crearTicket error:', error.message); return null; }
  return data;
}

async function getTicket(id) {
  if (!miraiSupabase) return null;
  const { data, error } = await miraiSupabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) { console.error('[itaca] getTicket error:', error.message); return null; }
  return data;
}

async function updateTicket(id, patch) {
  if (!miraiSupabase) return null;
  const { data, error } = await miraiSupabase
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) { console.error('[itaca] updateTicket error:', error.message); return null; }
  return data;
}

export async function listPendientes() {
  if (!miraiSupabase) return [];
  const { data, error } = await miraiSupabase
    .from(TABLE)
    .select('*')
    .in('estado', ['pendiente', 'en_progreso', 'pr_abierto'])
    .order('id', { ascending: true });
  if (error) { console.error('[itaca] listPendientes error:', error.message); return []; }
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Aprobación → crear issue en GitHub (lo dispara /ok N desde el privado de Mirai)
// ---------------------------------------------------------------------------
export async function aprobarCorreccion(id) {
  const t = await getTicket(id);
  if (!t) return `No encontré la corrección #${id}. Usa /correcciones para ver la lista.`;
  if (t.estado === 'descartada')    return `La corrección #${id} está descartada. Si la quieres, primero créala de nuevo.`;
  if (t.estado === 'en_progreso')   return `La corrección #${id} ya está en marcha (esperando que Claude abra el PR).`;
  if (t.estado === 'pr_abierto')    return `La corrección #${id} ya tiene un PR abierto:\n${t.pr_url || '(link en camino)'}`;
  if (t.estado === 'en_produccion') return `La corrección #${id} ya está en producción ✅.`;
  if (!githubReady()) return `Falta configurar *GITHUB_TOKEN* en el bot para abrir el issue. La #${id} sigue pendiente.`;

  try {
    // Sin labels: una etiqueta inexistente en el repo haría fallar la creación
    // del issue (422). El disparador de la Action es el "@claude" del cuerpo.
    const { number, url } = await createIssue({
      title: `[Corrección #${t.id}] ${t.titulo}`,
      body: issueBody(t),
    });
    await updateTicket(id, { estado: 'en_progreso', issue_number: number });
    return `🛠️ Mandé a implementar la corrección #${id}.\nIssue: ${url}\n\nEn cuanto Claude abra el PR te aviso para que lo revises y apruebes desde el cel.`;
  } catch (e) {
    console.error('[itaca] aprobar error:', e.message);
    await updateTicket(id, { estado: 'error' });
    return `⚠️ No pude abrir el issue para la #${id}: ${e.message}`;
  }
}

export async function descartarCorreccion(id) {
  const t = await getTicket(id);
  if (!t) return `No encontré la corrección #${id}.`;
  await updateTicket(id, { estado: 'descartada' });
  return `🗑️ Descarté la corrección #${id} ("${t.titulo}").`;
}

function issueBody(t) {
  return `@claude

Implementa el siguiente cambio pedido por el equipo (llegó por WhatsApp) en el sistema **ITACA Conversemos**.

**Corrección #${t.id} — pedida por ${t.autor || 'el equipo'}**

${t.detalle}

---
Instrucciones:
- Haz el cambio de forma acotada; no toques cosas no relacionadas con este pedido.
- Sigue las convenciones del proyecto (ver \`CLAUDE.md\`).
- Deja los cambios en tu rama de trabajo. **No hagas merge.** Mia abre el Pull Request
  y una persona lo revisa y aprueba antes de que se despliegue a producción.
- Si el pedido es ambiguo, elige la interpretación más razonable y explícala en el commit.`;
}

// ---------------------------------------------------------------------------
// Mensajes a Mirai
// ---------------------------------------------------------------------------
function formatoNuevaCorreccion(t) {
  return `📝 *Corrección #${t.id}* — de ${t.autor || 'el equipo'}\n*${t.titulo}*\n\n${t.detalle}\n\nResponde */ok ${t.id}* para implementar, o */descartar ${t.id}*.`;
}

export function formatoListaPendientes(tickets) {
  if (!tickets.length) return 'No hay correcciones pendientes 🌸';
  const iconos = { pendiente: '📝', en_progreso: '🛠️', pr_abierto: '🔧' };
  const lineas = tickets.map((t) => {
    const ico = iconos[t.estado] || '•';
    const extra = t.estado === 'pr_abierto' && t.pr_url ? `\n   → PR: ${t.pr_url}` : '';
    return `${ico} *#${t.id}* (${t.autor || '?'}) — ${t.titulo} _[${t.estado}]_${extra}`;
  });
  return `*Correcciones ITACA pendientes:*\n\n${lineas.join('\n')}\n\n/ok N para implementar · /descartar N para descartar`;
}

// ---------------------------------------------------------------------------
// Seguimiento de PRs (cron): avisa cuándo revisar y cuándo ya está en producción
// ---------------------------------------------------------------------------
export async function chequearPRs() {
  if (!config.mia.itaca?.enabled || !githubReady() || !miraiSupabase) return { checked: 0 };
  const { data, error } = await miraiSupabase
    .from(TABLE)
    .select('*')
    .in('estado', ['en_progreso', 'pr_abierto']);
  if (error) { console.error('[itaca] chequearPRs list error:', error.message); return { error: error.message }; }

  let notified = 0;
  for (const t of data ?? []) {
    if (!t.issue_number) continue;
    let pr = t.pr_number ? await getPR(t.pr_number) : await findLinkedPR(t.issue_number);

    // La Action de Claude empuja la rama `claude/issue-N-<ts>` pero NO abre el PR
    // (solo deja un link). Si aún no hay PR, lo abrimos nosotros desde esa rama.
    if (!pr && t.estado === 'en_progreso') {
      const branch = await findClaudeBranch(t.issue_number);
      if (branch) {
        try {
          pr = await createPR({
            head: branch,
            title: `[Corrección #${t.id}] ${t.titulo}`,
            body: `Implementa la corrección #${t.id}, pedida por ${t.autor || 'el equipo'} en el grupo de WhatsApp.\n\nCloses #${t.issue_number}`,
          });
          console.log(`[itaca] PR abierto para la corrección #${t.id}: ${pr?.url}`);
        } catch (e) {
          console.error(`[itaca] no pude abrir el PR de la #${t.id}:`, e.message);
        }
      }
    }
    if (!pr) continue;

    if (t.estado === 'en_progreso') {
      await updateTicket(t.id, { estado: 'pr_abierto', pr_number: pr.number, pr_url: pr.url });
      await avisarMirai(`🔧 *Corrección #${t.id} implementada* ("${t.titulo}").\nRevisa y aprueba el PR desde tu celular:\n${pr.url}\n\nCuando lo apruebes (merge), Railway despliega y te aviso.`);
      notified++;
      continue;
    }
    if (t.estado === 'pr_abierto' && pr.merged) {
      await updateTicket(t.id, { estado: 'en_produccion', pr_number: pr.number, pr_url: pr.url });
      await avisarMirai(`✅ *Corrección #${t.id} ya está en producción* ("${t.titulo}").\nAvísale a ${t.autor || 'quien la pidió'} que revise el sistema y te dé feedback 🌸`);
      notified++;
      continue;
    }
    if (t.estado === 'pr_abierto' && pr.state === 'closed' && !pr.merged) {
      await updateTicket(t.id, { estado: 'pendiente', pr_number: null, pr_url: null });
      await avisarMirai(`↩️ El PR de la corrección #${t.id} se cerró sin aplicarse. La dejé *pendiente* otra vez (puedes reintentar con /ok ${t.id}).`);
      notified++;
    }
  }
  return { checked: (data ?? []).length, notified };
}

export function startItacaPRCron() {
  if (!config.mia.itaca?.enabled) return;
  cron.schedule('*/3 * * * *', () => {
    chequearPRs().catch((e) => console.error('[itaca] cron chequearPRs:', e.message));
  });
  console.log('[itaca] cron de seguimiento de PRs activo (cada 3 min).');
}
