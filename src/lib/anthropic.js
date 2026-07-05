// Cliente Claude (Anthropic) — cerebro de la Fase 2 de Neura (recap de GDH,
// reportes, reflexión). Si no hay ANTHROPIC_API_KEY, exportamos null y el
// módulo que lo use degrada con elegancia.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const key = config.mia.anthropicApiKey;

export const anthropic = key ? new Anthropic({ apiKey: key }) : null;

// Modelo por defecto — el más capaz de Anthropic para razonar y redactar.
export const CLAUDE_MODEL = 'claude-opus-4-8';
