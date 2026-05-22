// Carga el SYSTEM_PROMPT de Mia desde src/prompts/mia.txt.
// Mismo patrón que ai.js carga MKT_SYSTEM_PROMPT y MIRAI_OPS_SYSTEM_PROMPT.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIA_SYSTEM_PROMPT = readFileSync(
  resolve(__dirname, '../../prompts/mia.txt'),
  'utf8',
);

export const MIA_PROMPT_PLACEHOLDER = MIA_SYSTEM_PROMPT.startsWith('PROMPT_PENDIENTE');
