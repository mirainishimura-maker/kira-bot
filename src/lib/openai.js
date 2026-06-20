import OpenAI from 'openai';
import { config } from '../config.js';

// Cliente OpenAI de la EMPRESA (KIRA-mkt). En modo MIA_ONLY no hay key
// corporativa → null. Mia usa su propio cliente (miraiOpenai), no este.
export const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
export const MODEL = config.openai.model;
