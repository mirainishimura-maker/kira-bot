-- =====================================================================
-- KIRA — Migración 001
-- Cambios sobre el schema inicial:
--   * member_role: agregar 'project_manager'
--   * task_type: agregar 'publishing'
--   * team_members: + is_admin, + availability_notes
--   * clients: rename contact_name -> contact_person, + notes
--   * content_projects: + description, + updated_at
--   * tasks: + updated_at
--   * kira_memory: + channel
--   * NUEVA tabla: productivity_log
--
-- Ejecutar en Supabase SQL Editor.
-- Es idempotente: se puede correr varias veces sin romper nada.
-- =====================================================================

-- ---------- ENUMs ----------
DO $$ BEGIN
  ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'project_manager';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE task_type ADD VALUE IF NOT EXISTS 'publishing';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TYPE memory_channel AS ENUM ('group', 'private');

-- ---------- team_members ----------
ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS availability_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_team_members_admin ON team_members(is_admin) WHERE is_admin;

-- ---------- clients ----------
DO $$ BEGIN
  ALTER TABLE clients RENAME COLUMN contact_name TO contact_person;
EXCEPTION WHEN undefined_column THEN NULL; END $$;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- ---------- content_projects ----------
ALTER TABLE content_projects
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ---------- tasks ----------
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ---------- kira_memory ----------
ALTER TABLE kira_memory
  ADD COLUMN IF NOT EXISTS channel memory_channel;

-- ---------- productivity_log (NUEVA) ----------
CREATE TABLE IF NOT EXISTS productivity_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id                UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  log_date                 DATE NOT NULL,
  tasks_assigned           INTEGER NOT NULL DEFAULT 0 CHECK (tasks_assigned   >= 0),
  tasks_completed          INTEGER NOT NULL DEFAULT 0 CHECK (tasks_completed  >= 0),
  tasks_incomplete         INTEGER NOT NULL DEFAULT 0 CHECK (tasks_incomplete >= 0),
  is_fault                 BOOLEAN NOT NULL DEFAULT FALSE,
  fault_count_cumulative   INTEGER NOT NULL DEFAULT 0 CHECK (fault_count_cumulative >= 0),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT productivity_log_unique UNIQUE (member_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_productivity_member_date ON productivity_log(member_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_productivity_faults      ON productivity_log(member_id, fault_count_cumulative) WHERE is_fault;

ALTER TABLE productivity_log ENABLE ROW LEVEL SECURITY;

-- ---------- updated_at triggers (opcional pero útil) ----------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_projects_updated_at ON content_projects;
CREATE TRIGGER trg_content_projects_updated_at
  BEFORE UPDATE ON content_projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
