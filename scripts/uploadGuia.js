// Sube el lead magnet (PDF) al bucket público `neura` y muestra la URL pública.
import fs from 'fs';
import { config } from '../src/config.js';
import { miraiSupabase } from '../src/lib/miraiSupabase.js';

const FILE = 'C:\\projects\\nowa\\neura_studio\\lead_magnet\\NEURA - Calma tu ansiedad (guia gratis).pdf';
const bucket = config.neura.bucket || 'neura';
const key = 'guias/calma-tu-ansiedad.pdf';

const buf = fs.readFileSync(FILE);
const { error } = await miraiSupabase.storage.from(bucket)
  .upload(key, buf, { contentType: 'application/pdf', upsert: true });
if (error) { console.error('ERROR:', error.message); process.exit(1); }
const { data } = miraiSupabase.storage.from(bucket).getPublicUrl(key);
console.log('URL:', data.publicUrl);
