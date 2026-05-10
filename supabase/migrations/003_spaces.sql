-- =====================================================================
-- KIRA — Migración 003 (esquema)
-- Multi-espacio: KIRA pasa de "el bot del equipo de mkt" a soportar
-- múltiples espacios independientes (mkt, cumples Piura/ECO/Lima,
-- agenda personal de Mirai, etc.).
--
-- Cambios:
--   * Nuevo enum space_kind
--   * member_role: agregar 'owner' (dueño de un espacio externo)
--   * NUEVA tabla: spaces
--   * NUEVA tabla: space_members
--
-- IMPORTANTE: ejecutar este archivo PRIMERO en Supabase SQL Editor.
-- Luego ejecutar 004_spaces_data.sql en una segunda corrida — Postgres
-- no deja usar un valor de enum recién agregado en la misma transacción
-- donde se hizo el ALTER TYPE ... ADD VALUE.
--
-- Idempotente: se puede correr varias veces sin romper nada.
-- =====================================================================

-- ---------- ENUMs ----------
DO $$ BEGIN
  CREATE TYPE space_kind AS ENUM (
    'team_marketing',      -- mkt: multi-miembro, grupo + privado, bidireccional
    'birthday_reminders',  -- cumples: 1 owner, solo privado, unidireccional
    'personal_ops'         -- agenda personal: 1 owner, solo privado, bidireccional
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'owner';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- spaces ----------
CREATE TABLE IF NOT EXISTS spaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          space_kind NOT NULL,
  group_jid     TEXT UNIQUE,
  sheet_id      TEXT,
  sheet_url     TEXT,
  sheet_secret  TEXT,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spaces_kind   ON spaces(kind)   WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_spaces_active ON spaces(is_active);

DROP TRIGGER IF EXISTS trg_spaces_updated_at ON spaces;
CREATE TRIGGER trg_spaces_updated_at
  BEFORE UPDATE ON spaces
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- space_members ----------
-- Pivote que vincula miembros (team_members) a espacios. Un mismo miembro
-- puede pertenecer a varios espacios con distinto rol específico.
CREATE TABLE IF NOT EXISTS space_members (
  space_id   UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  member_id  UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  is_owner   BOOLEAN NOT NULL DEFAULT FALSE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (space_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_space_members_member ON space_members(member_id);
CREATE INDEX IF NOT EXISTS idx_space_members_owner  ON space_members(space_id) WHERE is_owner;

-- ---------- RLS ----------
ALTER TABLE spaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_members ENABLE ROW LEVEL SECURITY;
