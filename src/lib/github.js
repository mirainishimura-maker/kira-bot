// Cliente mínimo de la API de GitHub para el flujo de correcciones de ITACA.
// Mia abre un issue etiquetando a @claude; la GitHub Action de Claude Code lo
// implementa en una rama y abre un PR. Aquí solo creamos el issue y consultamos
// el estado del PR vinculado (para avisarle a Mirai cuándo revisar y cuándo ya
// está en producción). Usa fetch nativo (Node 18+) — sin dependencias nuevas.

import { config } from '../config.js';

const API = 'https://api.github.com';

function itacaCfg() {
  return config.mia.itaca;
}

export function githubReady() {
  const c = itacaCfg();
  return Boolean(c?.githubToken && c?.repo);
}

async function gh(path, { method = 'GET', body } = {}) {
  const c = itacaCfg();
  if (!c?.githubToken) throw new Error('GITHUB_TOKEN no configurado en el bot');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'kira-bot-itaca',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Crea un issue en el repo de ITACA. Devuelve { number, html_url }.
export async function createIssue({ title, body, labels = [] }) {
  const c = itacaCfg();
  const data = await gh(`/repos/${c.repo}/issues`, {
    method: 'POST',
    body: { title, body, labels },
  });
  return { number: data.number, url: data.html_url };
}

// Estado de un issue. Devuelve { state: 'open'|'closed' } o null.
export async function getIssue(number) {
  const c = itacaCfg();
  try {
    const data = await gh(`/repos/${c.repo}/issues/${number}`);
    return { state: data.state };
  } catch (err) {
    console.error('[github] getIssue error:', err.message);
    return null;
  }
}

// Busca el PR que la Action abrió para este issue. La Action referencia el issue
// (ej. "Closes #N"), lo que deja un evento cross-referenced en el timeline del
// issue. Devolvemos el PR más reciente vinculado, o null si aún no hay.
// Devuelve { number, url, state, merged }.
export async function findLinkedPR(issueNumber) {
  const c = itacaCfg();
  let events;
  try {
    events = await gh(`/repos/${c.repo}/issues/${issueNumber}/timeline?per_page=100`);
  } catch (err) {
    console.error('[github] timeline error:', err.message);
    return null;
  }
  if (!Array.isArray(events)) return null;

  // Recorremos de atrás hacia adelante: el cross-reference más reciente a un PR.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.event !== 'cross-referenced') continue;
    const src = ev?.source?.issue;
    if (src?.pull_request) {
      return await getPR(src.number);
    }
  }
  return null;
}

// Estado de un PR. Devuelve { number, url, state, merged, title } o null.
export async function getPR(number) {
  const c = itacaCfg();
  try {
    const data = await gh(`/repos/${c.repo}/pulls/${number}`);
    return {
      number: data.number,
      url: data.html_url,
      state: data.state,          // 'open' | 'closed'
      merged: Boolean(data.merged),
      title: data.title,
    };
  } catch (err) {
    console.error('[github] getPR error:', err.message);
    return null;
  }
}
