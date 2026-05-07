-- =====================================================================
-- KIRA — Migración 002
-- Datos: actualizar Luisa, agregar Astrid, cargar 8 clientes reales.
-- Ejecutar DESPUÉS de 001_updates.sql.
-- Idempotente — se puede correr varias veces.
-- =====================================================================

-- ---------- Equipo ----------
UPDATE team_members SET role = 'project_manager', is_admin = TRUE
  WHERE name = 'Luisa';

UPDATE team_members SET availability_notes = 'A veces tiene clases de universidad — registra ausencias cuando avise'
  WHERE name = 'Analú';

UPDATE team_members SET availability_notes = 'A veces solo viene 3 horas — necesita instrucciones cortas y claras'
  WHERE name = 'Brando Franco';

UPDATE team_members SET availability_notes = 'No asignar edición y grabación el mismo día. Edita 3-4 videos/día. Graba 18+ videos/día.'
  WHERE name = 'Piero';

UPDATE team_members SET availability_notes = 'Medio tiempo. NO disponible martes ni jueves.'
  WHERE name = 'Jocelyn';

INSERT INTO team_members (name, role, phone, is_admin, daily_capacity, availability_notes)
  VALUES ('Astrid', 'leader', NULL, TRUE, 6, 'Apoya a Luisa. Mismos permisos admin que Luisa.')
  ON CONFLICT DO NOTHING;

-- ---------- Clientes ----------
INSERT INTO clients (name, contact_person) VALUES
  ('ArtaMax',                'Max'),
  ('Ítaca Kids Piura',       NULL),
  ('Ítaca Kids Lima',        NULL),
  ('Ítaca Kids Arequipa',    NULL),
  ('Eco',                    NULL),
  ('Conversemos',            NULL),
  ('Educación',              NULL),
  ('Club de Arte y Cultura', NULL)
ON CONFLICT DO NOTHING;
