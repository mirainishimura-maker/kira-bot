-- =====================================================================
-- KIRA — Migración 004 (data)
-- Crea los 5 espacios iniciales y vincula miembros.
--
-- Espacios:
--   1. mkt                          — equipo marketing Ítaca HUB (existente)
--   2. itaca_kids_piura_birthdays   — cumples Piura, owner Mattias, 7 AM
--   3. eco_birthdays                — cumples ECO Canto, owner Mirai,  7 AM
--   4. itaca_kids_lima_birthdays    — cumples Lima,  owner Diana,  7 AM
--   5. mirai_ops                    — agenda operativa Mirai, 8 AM, bidireccional
--
-- IMPORTANTE: ejecutar DESPUÉS de 003_spaces.sql.
-- Idempotente — se puede correr varias veces.
--
-- sheet_url y sheet_secret quedan NULL por ahora — se llenan en el paso 2
-- cuando despleguemos los Apps Scripts de cada hoja.
-- =====================================================================

-- ---------- Miembros ----------

-- Mirai ya existe en team_members desde el seed inicial (phone 51904301391, su
-- celular personal). NO la re-insertamos aquí — el número 51977668497 es de la
-- instancia kiramkt del bot, no de Mirai. Los vínculos de abajo la referencian
-- por phone='51904301391', no por name, para evitar ambigüedad si algún día
-- hubiera otra persona con el mismo nombre.

-- Mattias (Ítaca Kids Piura, owner del cron de cumples Piura)
INSERT INTO team_members (name, role, phone, is_admin, daily_capacity, availability_notes)
  VALUES ('Mattias', 'owner', '51960044755', FALSE, 5, 'Recibe cron diario 7 AM con cumples del día (Ítaca Kids Piura).')
  ON CONFLICT (phone) DO NOTHING;

-- Diana (Ítaca Kids Lima, owner del cron de cumples Lima)
INSERT INTO team_members (name, role, phone, is_admin, daily_capacity, availability_notes)
  VALUES ('Diana', 'owner', '51963781075', FALSE, 5, 'Recibe cron diario 7 AM con cumples del día (Ítaca Kids Lima — Miraflores y Olivos).')
  ON CONFLICT (phone) DO NOTHING;

-- ---------- Espacios ----------

-- 1. Espacio mkt (existente). El group_jid se mueve aquí desde la env GROUP_JID.
INSERT INTO spaces (slug, name, kind, group_jid, config)
  VALUES (
    'mkt',
    'Marketing Ítaca HUB',
    'team_marketing',
    '120363403051161584@g.us',
    '{"interactive": true, "has_group": true, "has_private_dms": true}'::jsonb
  )
  ON CONFLICT (slug) DO NOTHING;

-- 2. Cumples Ítaca Kids Piura
INSERT INTO spaces (slug, name, kind, group_jid, sheet_id, config)
  VALUES (
    'itaca_kids_piura_birthdays',
    'Cumpleaños Ítaca Kids Piura',
    'birthday_reminders',
    NULL,
    '1Z2Izlk19hKVcpDPXFB7t_ggGJZLEacaZwFXnTzZyXAY',
    '{"interactive": false, "cron_morning_hour": 7, "audience": "all_ages", "sede_default_label": "verificar sede", "sama_suffix": "(Sama)"}'::jsonb
  )
  ON CONFLICT (slug) DO NOTHING;

-- 3. Cumples ECO Canto
INSERT INTO spaces (slug, name, kind, group_jid, sheet_id, config)
  VALUES (
    'eco_birthdays',
    'Cumpleaños ECO Canto',
    'birthday_reminders',
    NULL,
    '1VHuI-2i02wQIbx1QqyR7sSDWHnE-Kz0hsaLGVILbPQE',
    '{"interactive": false, "cron_morning_hour": 7, "audience": "all_ages", "sede_fixed": "Piura", "sheet_tab_gid": "1279011654"}'::jsonb
  )
  ON CONFLICT (slug) DO NOTHING;

-- 4. Cumples Ítaca Kids Lima
INSERT INTO spaces (slug, name, kind, group_jid, sheet_id, config)
  VALUES (
    'itaca_kids_lima_birthdays',
    'Cumpleaños Ítaca Kids Lima',
    'birthday_reminders',
    NULL,
    '1M4TbRUHT9ddbwKzJWa3SuwRkI2FpIWctHXxG7eJwWr0',
    '{"interactive": false, "cron_morning_hour": 7, "audience": "all_ages", "sede_column": "SEDE", "sede_values": ["MIRAFLORES", "LOS OLIVOS"]}'::jsonb
  )
  ON CONFLICT (slug) DO NOTHING;

-- 5. Mirai ops (agenda operativa personal)
INSERT INTO spaces (slug, name, kind, group_jid, sheet_id, config)
  VALUES (
    'mirai_ops',
    'Agenda operativa Mirai',
    'personal_ops',
    NULL,
    NULL,                  -- sheet_id se asigna cuando creemos la hoja en el paso 2
    '{"interactive": true, "cron_morning_hour": 8}'::jsonb
  )
  ON CONFLICT (slug) DO NOTHING;

-- ---------- Vincular miembros existentes al espacio mkt ----------
-- Todos los activos (Luisa, Astrid, Analú, Brando, Piero, Jocelyn, Mirai)
-- pasan a ser miembros del espacio mkt. is_owner = is_admin (Luisa, Astrid, Mirai).
INSERT INTO space_members (space_id, member_id, is_owner)
  SELECT s.id, m.id, m.is_admin
  FROM spaces s
  CROSS JOIN team_members m
  WHERE s.slug = 'mkt'
    AND m.is_active = TRUE
    AND m.role <> 'owner'  -- Mattias y Diana NO son del equipo mkt
  ON CONFLICT DO NOTHING;

-- ---------- Vincular owners a sus espacios de cumples / ops ----------

-- Mattias → Cumples Piura (owner). Match por phone para evitar ambigüedad.
INSERT INTO space_members (space_id, member_id, is_owner)
  SELECT s.id, m.id, TRUE
  FROM spaces s, team_members m
  WHERE s.slug = 'itaca_kids_piura_birthdays' AND m.phone = '51960044755'
  ON CONFLICT DO NOTHING;

-- Mirai → Cumples ECO (owner)
INSERT INTO space_members (space_id, member_id, is_owner)
  SELECT s.id, m.id, TRUE
  FROM spaces s, team_members m
  WHERE s.slug = 'eco_birthdays' AND m.phone = '51904301391'
  ON CONFLICT DO NOTHING;

-- Diana → Cumples Lima (owner)
INSERT INTO space_members (space_id, member_id, is_owner)
  SELECT s.id, m.id, TRUE
  FROM spaces s, team_members m
  WHERE s.slug = 'itaca_kids_lima_birthdays' AND m.phone = '51963781075'
  ON CONFLICT DO NOTHING;

-- Mirai → Mirai ops (owner)
INSERT INTO space_members (space_id, member_id, is_owner)
  SELECT s.id, m.id, TRUE
  FROM spaces s, team_members m
  WHERE s.slug = 'mirai_ops' AND m.phone = '51904301391'
  ON CONFLICT DO NOTHING;
