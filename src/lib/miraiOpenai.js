// Cliente OpenAI de la cuenta PERSONAL de Mirai (módulo Mia).
// Aislado del OpenAI de la empresa. Si la API key no está, null.

import OpenAI from 'openai';
import { config } from '../config.js';

export const miraiOpenai = config.mia.enabled
  ? new OpenAI({ apiKey: config.mia.openai.apiKey })
  : null;

export const MIA_MODEL = config.mia.openai.model;
