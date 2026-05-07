-- =====================================================================
-- KIRA — Task Management Agent
-- Schema PostgreSQL para Supabase
-- Versión 1.0 — Mayo 2026
-- =====================================================================
--
-- Ejecutar en Supabase SQL Editor en este orden:
--   1. schema.sql  (este archivo: tipos, tablas, índices, RLS)
--   2. seed.sql    (datos iniciales: equipo de marketing Ítaca HUB)
--
-- El bot se conecta con SERVICE_ROLE_KEY (bypass de RLS).
-- RLS queda activo para bloquear acceso anónimo accidental.
-- =====================================================================

-- ---------- Extensiones ----------
-- pgcrypto provee gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- Tipos ENUM ----------
CREATE TYPE member_role AS ENUM (
  'leader',
  'content_creator',
  'pautero',
  'videographer',
  'designer'
);

CREATE TYPE project_status AS ENUM (
  'draft',
  'in_progress',
  'delivered',
  'closed'
);

CREATE TYPE task_type AS ENUM (
  'client_meeting',
  'content_guide',
  'review',
  'filming',
  'editing',
  'design',
  'pauta'
);

CREATE TYPE task_status AS ENUM (
  'pending',
  'in_progress',
  'blocked',
  'done'
);

CREATE TYPE task_priority AS ENUM (
  'urgent',
  'high',
  'normal',
  'low'
);

CREATE TYPE report_type AS ENUM (
  'morning_plan',
  'evening_report'
);

-- =====================================================================
-- 4.1  team_members
-- =====================================================================
CREATE TABLE team_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  role            member_role NOT NULL,
  -- phone: formato E.164 sin signo +, por ejemplo 51999999999
  phone           TEXT UNIQUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  daily_capacity  INTEGER NOT NULL DEFAULT 5 CHECK (daily_capacity > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_team_members_phone   ON team_members(phone) WHERE is_active;
CREATE INDEX idx_team_members_role    ON team_members(role)  WHERE is_active;

-- =====================================================================
-- 4.2  clients
-- =====================================================================
CREATE TABLE clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  contact_name  TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clients_active ON clients(is_active);

-- =====================================================================
-- 4.3  content_projects
-- =====================================================================
CREATE TABLE content_projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  title           TEXT NOT NULL,
  deadline        DATE,
  total_videos    INTEGER NOT NULL DEFAULT 0 CHECK (total_videos  >= 0),
  total_designs   INTEGER NOT NULL DEFAULT 0 CHECK (total_designs >= 0),
  status          project_status NOT NULL DEFAULT 'draft',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_projects_client    ON content_projects(client_id);
CREATE INDEX idx_projects_status    ON content_projects(status);
CREATE INDEX idx_projects_deadline  ON content_projects(deadline) WHERE status IN ('draft','in_progress');

-- =====================================================================
-- 4.4  tasks  (tabla central)
-- =====================================================================
CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
  assigned_to      UUID REFERENCES team_members(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  task_type        task_type NOT NULL,
  status           task_status NOT NULL DEFAULT 'pending',
  priority         task_priority NOT NULL DEFAULT 'normal',
  depends_on       UUID REFERENCES tasks(id) ON DELETE SET NULL,
  due_date         DATE,
  estimated_hours  DECIMAL(5,2) CHECK (estimated_hours IS NULL OR estimated_hours >= 0),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Una tarea no puede depender de sí misma
  CONSTRAINT tasks_no_self_dep CHECK (id <> depends_on),
  -- completed_at solo si status = done
  CONSTRAINT tasks_completed_consistency CHECK (
    (status = 'done' AND completed_at IS NOT NULL) OR
    (status <> 'done' AND completed_at IS NULL)
  )
);

CREATE INDEX idx_tasks_assigned        ON tasks(assigned_to)  WHERE status IN ('pending','in_progress','blocked');
CREATE INDEX idx_tasks_project         ON tasks(project_id);
CREATE INDEX idx_tasks_status          ON tasks(status);
CREATE INDEX idx_tasks_priority        ON tasks(priority)     WHERE status <> 'done';
CREATE INDEX idx_tasks_due_date        ON tasks(due_date)     WHERE status <> 'done';
CREATE INDEX idx_tasks_depends_on      ON tasks(depends_on)   WHERE depends_on IS NOT NULL;
CREATE INDEX idx_tasks_assigned_due    ON tasks(assigned_to, due_date) WHERE status <> 'done';

-- =====================================================================
-- 4.5  daily_reports
-- =====================================================================
CREATE TABLE daily_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  report_date   DATE NOT NULL,
  report_type   report_type NOT NULL,
  raw_message   TEXT,
  parsed_tasks  JSONB,
  blockers      TEXT,
  mood_score    INTEGER CHECK (mood_score IS NULL OR mood_score BETWEEN 1 AND 5),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Un solo reporte por miembro/día/tipo
  CONSTRAINT daily_reports_unique UNIQUE (member_id, report_date, report_type)
);

CREATE INDEX idx_reports_member_date ON daily_reports(member_id, report_date DESC);
CREATE INDEX idx_reports_date_type   ON daily_reports(report_date DESC, report_type);

-- =====================================================================
-- 4.6  kira_memory
-- =====================================================================
CREATE TABLE kira_memory (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id          UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  conversation_date  DATE NOT NULL,
  summary            TEXT NOT NULL,
  action_items       JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_member_date ON kira_memory(member_id, conversation_date DESC);

-- =====================================================================
-- Row Level Security
-- =====================================================================
-- El bot usa SERVICE_ROLE_KEY que bypassa RLS automáticamente.
-- Activamos RLS sin políticas para que `anon` y `authenticated` no
-- puedan leer ni escribir nada por accidente.

ALTER TABLE team_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_projects  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_reports     ENABLE ROW LEVEL SECURITY;
ALTER TABLE kira_memory       ENABLE ROW LEVEL SECURITY;
