-- =====================================================================
-- KIRA — Seed inicial
-- Equipo de marketing de Ítaca HUB
-- =====================================================================
-- Ejecutar DESPUÉS de schema.sql.
-- Reemplazar los teléfonos con los números reales (formato E.164 sin '+').
-- Ejemplo Perú: 51999999999
-- =====================================================================

INSERT INTO team_members (name, role, phone, daily_capacity) VALUES
  ('Luisa',         'leader',          NULL, 6),
  ('Analú',         'content_creator', NULL, 4),
  ('Brando Franco', 'pautero',         NULL, 5),
  ('Piero',         'videographer',    NULL, 5),
  ('Jocelyn',       'designer',        NULL, 6);

-- Una vez tengas los números, actualízalos así:
--   UPDATE team_members SET phone = '51XXXXXXXXX' WHERE name = 'Luisa';
