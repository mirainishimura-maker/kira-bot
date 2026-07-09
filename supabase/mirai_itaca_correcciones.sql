-- Correcciones de ITACA capturadas desde el grupo "conversemos las tres".
-- Correr en el SQL Editor del Supabase PRIVADO de Mirai (MIRAI_SUPABASE_URL),
-- el mismo donde vive la tabla `patients`.
--
-- El id es el número que Mia usa con Mirai: "Corrección #7", "/ok 7", "/descartar 7".
--
-- Estados:
--   pendiente     · detectada, esperando el /ok de Mirai
--   en_progreso   · issue creado en GitHub, Claude implementando (aún sin PR)
--   pr_abierto    · hay un PR; Mirai debe revisarlo/aprobarlo
--   en_produccion · PR mergeado (Railway ya desplegó)
--   descartada    · Mirai la descartó
--   error         · no se pudo abrir el issue

create table if not exists itaca_correcciones (
  id           bigserial primary key,
  autor        text,
  titulo       text not null,
  detalle      text not null,
  estado       text not null default 'pendiente',
  issue_number integer,
  pr_number    integer,
  pr_url       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists itaca_correcciones_estado_idx on itaca_correcciones (estado);
