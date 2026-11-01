-- =====================================================================
-- NAP-IQ  |  Populate plans, installed dates and installation tickets
--           PostgreSQL / Supabase
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run.  Safe to run more than once (it only fills in what is
-- still missing).
--
-- WHAT IT DOES
--   1. Makes sure the 3 plans exist in `plans`:
--        Fiber 15Mbps  P999.00 | Fiber 25Mbps  P1,500.00 | Fiber 60Mbps  P2,500.00
--   2. Gives every subscriber with no plan a RANDOM one of those 3
--      (subscribers.plan_type).
--   3. Sets a RANDOM `installed_at` for every installed subscriber that has
--      none, picked so the first monthly due date (installed_at + 1 month)
--      always falls in LAST MONTH or THIS MONTH. (Run on 2026-11-01 this
--      means installed 2026-09-01 .. 2026-10-31, due 2026-10-01 .. 2026-11-30.)
--      Subscribers whose status is 'pending_review' are new applications,
--      so they are left uninstalled.
--   4. Creates one completed "New Installation" ticket (service_requests,
--      shown as SO-000N on the Tickets page) for every installed subscriber
--      that does not have one yet, assigned to a RANDOM team from
--      Technician -> Teams. Like the app does, one assignment is created
--      for EVERY member of that team.
--   5. Fills the NAP port number on those assignments from
--      NAP-MONITORING.xlsx, so the subscriber popup shows the real port.
--      Subscribers not found in the sheet keep the app's automatic port.
--
-- NEEDS: at least one team (with members) created under Technician.
--
-- ALREADY RAN AN EARLIER VERSION OF THIS FILE? Uncomment the RESET block
-- right below first. It removes the tickets/assignments this script made
-- and clears the installed dates it set, so they get generated again with
-- the new date range.
-- =====================================================================

BEGIN;

-- ---- RESET (optional): uncomment the lines between the markers --------
-- DELETE FROM assignments WHERE service_request_id IN (
--     SELECT r.id FROM service_requests r
--     WHERE r.request_type = 'new_installation' AND r.status = 'completed'
--       AND r.notes LIKE 'Assigned Team: %');
-- UPDATE subscribers SET installed_at = NULL
-- WHERE id IN (
--     SELECT r.subscriber_id FROM service_requests r
--     WHERE r.request_type = 'new_installation' AND r.status = 'completed'
--       AND r.notes LIKE 'Assigned Team: %');
-- DELETE FROM service_requests
-- WHERE request_type = 'new_installation' AND status = 'completed'
--   AND notes LIKE 'Assigned Team: %';
-- ---- end RESET ---------------------------------------------------------

-- ---------------------------------------------------------------------
-- 0. Keep the id sequences ahead of any ids that were inserted by hand
--    (prevents "duplicate key" errors after a bulk import).
-- ---------------------------------------------------------------------
SELECT setval(pg_get_serial_sequence('plans', 'id'),
              COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM plans;
SELECT setval(pg_get_serial_sequence('service_requests', 'id'),
              COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM service_requests;
SELECT setval(pg_get_serial_sequence('assignments', 'id'),
              COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM assignments;

-- ---------------------------------------------------------------------
-- 1. Plans
-- ---------------------------------------------------------------------
INSERT INTO plans (name, monthly_fee) VALUES
    ('Fiber 15Mbps',   999.00),
    ('Fiber 25Mbps',  1500.00),
    ('Fiber 60Mbps',  2500.00)
ON CONFLICT (name) DO UPDATE SET monthly_fee = EXCLUDED.monthly_fee;

-- ---------------------------------------------------------------------
-- 2. Random plan for every subscriber that has none
-- ---------------------------------------------------------------------
UPDATE subscribers
SET plan_type  = (ARRAY['Fiber 15Mbps', 'Fiber 25Mbps', 'Fiber 60Mbps'])[1 + floor(random() * 3)::int],
    updated_at = now()
WHERE plan_type IS NULL OR btrim(plan_type) = '';

-- ---------------------------------------------------------------------
-- 3. Random installed date (new applications stay uninstalled)
-- ---------------------------------------------------------------------
UPDATE subscribers s
SET installed_at = d.start_date + floor(random() * (d.end_date - d.start_date + 1))::int,
    updated_at   = now()
FROM (SELECT (date_trunc('month', current_date) - interval '2 months')::date AS start_date,
             (date_trunc('month', current_date) - interval '1 day')::date    AS end_date) d
WHERE s.installed_at IS NULL
  AND s.status <> 'pending_review';

-- ---------------------------------------------------------------------
-- 4. Installation tickets + team assignments
-- ---------------------------------------------------------------------

-- Port numbers from NAP-MONITORING.xlsx (matched on subscriber name).
CREATE TEMP TABLE _sheet_ports (full_name text, port integer) ON COMMIT DROP;
INSERT INTO _sheet_ports (full_name, port) VALUES
    ('Adrian Molina', 9),
    ('Adrian Morales', 5),
    ('Alyssa Flores', 12),
    ('Alyssa Torres', 2),
    ('Angelica Gonzales', 5),
    ('Angelica Pineda', 6),
    ('Angelica Santiago', 1),
    ('Angelo Pascual', 14),
    ('Bea De Leon', 2),
    ('Bea Manalo', 6),
    ('Bea Santos', 10),
    ('Bea Tolentino', 4),
    ('Bryan De Leon', 5),
    ('Bryan Santos', 9),
    ('Bryan Tolentino', 13),
    ('Camille David', 7),
    ('Camille Pineda', 4),
    ('Camille Santiago', 8),
    ('Carlo Velasco', 1),
    ('Catherine Domingo', 7),
    ('Catherine Garcia', 15),
    ('Christian De Leon', 15),
    ('Christian Dela Cruz', 13),
    ('Christian Tolentino', 1),
    ('Clarisse Magsino', 8),
    ('Daniel Aguilar', 4),
    ('Daniel Bautista', 13),
    ('Daniel Bernardo', 14),
    ('Daniel Manalo', 2),
    ('Diane Molina', 1),
    ('Diane Morales', 9),
    ('Edward Aquino', 8),
    ('Edward Manalo', 6),
    ('Edward Salazar', 8),
    ('Gabriel Fernandez', 15),
    ('Gabriel Mercado', 3),
    ('Gabriel Molina', 7),
    ('Gabriel Morales', 3),
    ('Grace Aquino', 11),
    ('Grace Mendoza', 2),
    ('James Aguilar', 10),
    ('James Bautista', 2),
    ('James Lim', 5),
    ('James Valdez', 5),
    ('Janine Pascual', 6),
    ('Janine Torres', 5),
    ('Jasmine Mercado', 9),
    ('Jasmine Santos', 4),
    ('Jayson Castillo', 6),
    ('Jayson Estrada', 1),
    ('Jayson Garcia', 3),
    ('Jenelyn Castillo', 7),
    ('Jenelyn Garcia', 1),
    ('Jenelyn Rivera', 4),
    ('Jenelyn Rosales', 8),
    ('Jerome Gonzales', 1),
    ('Jerome Navarro', 3),
    ('Jerome Santiago', 4),
    ('Jessa David', 14),
    ('Jessa Mendoza', 9),
    ('John Ramos', 4),
    ('John Santos', 9),
    ('Joshua Aquino', 14),
    ('Joshua Manalo', 13),
    ('Joshua Soriano', 7),
    ('Joy Padilla', 1),
    ('Joy Velasco', 10),
    ('Juan Molina', 10),
    ('Juan Morales', 8),
    ('Katrina Bernardo', 3),
    ('Katrina Salazar', 12),
    ('Katrina Soriano', 2),
    ('Kenneth Aguilar', 6),
    ('Kenneth Bautista', 5),
    ('Kenneth Magsino', 11),
    ('Kevin Bernardo', 16),
    ('Kevin Manalo', 10),
    ('Kevin Soriano', 3),
    ('Kimberly Fernandez', 2),
    ('Kimberly Molina', 12),
    ('Kimberly Morales', 2),
    ('Kristine Lim', 15),
    ('Kristine Reyes', 3),
    ('Kristine Valdez', 16),
    ('Leah Rosales', 4),
    ('Lovely Dela Cruz', 5),
    ('Lovely Padilla', 11),
    ('Lovely Velasco', 1),
    ('Lovely Villanueva', 8),
    ('Luis Reyes', 5),
    ('Marco Fernandez', 3),
    ('Marco Ramos', 13),
    ('Maria David', 3),
    ('Maria Salazar', 1),
    ('Mark Flores', 8),
    ('Mark Reyes', 16),
    ('Mark Valdez', 4),
    ('Mary Domingo', 11),
    ('Mary Rivera', 2),
    ('Mary Velasco', 14),
    ('Mia Gonzales', 2),
    ('Mia Navarro', 7),
    ('Mia Santiago', 6),
    ('Michael De Leon', 9),
    ('Michael Manalo', 7),
    ('Michael Ramos', 1),
    ('Michael Tolentino', 12),
    ('Miguel Castillo', 8),
    ('Miguel Garcia', 8),
    ('Mika Bautista', 1),
    ('Mika Bernardo', 8),
    ('Mika Magsino', 7),
    ('Mika Manalo', 3),
    ('Nathan Flores', 5),
    ('Nathan Pascual', 10),
    ('Nathan Reyes', 5),
    ('Nathan Torres', 12),
    ('Nicole Flores', 6),
    ('Nicole Reyes', 13),
    ('Nicole Valdez', 9),
    ('Noel Bautista', 2),
    ('Noel Bernardo', 7),
    ('Noel Manalo', 6),
    ('Noel Soriano', 3),
    ('Paolo Aquino', 6),
    ('Paolo David', 16),
    ('Paolo Mendoza', 1),
    ('Paolo Pineda', 8),
    ('Paolo Salazar', 7),
    ('Patrick Tolentino', 12),
    ('Princess Garcia', 8),
    ('Princess Pascual', 7),
    ('Princess Rosales', 4),
    ('Rafael Aguilar', 2),
    ('Rafael Magsino', 4),
    ('Rafael Valdez', 2),
    ('Renz David', 16),
    ('Renz Gonzales', 4),
    ('Renz Pineda', 1),
    ('Renz Santiago', 3),
    ('Rhea Estrada', 7),
    ('Rhea Pascual', 15),
    ('Rhea Torres', 11),
    ('Ronald Dela Cruz', 3),
    ('Ronald Manalo', 7),
    ('Ronald Villanueva', 11),
    ('Rose Aquino', 2),
    ('Rose David', 6),
    ('Rose Mendoza', 10),
    ('Rose Pineda', 10),
    ('Ryan Manalo', 1),
    ('Ryan Padilla', 3),
    ('Ryan Villanueva', 11),
    ('Samantha De Leon', 3),
    ('Samantha Manalo', 6),
    ('Shaira Cruz', 4),
    ('Shaira Gonzales', 7),
    ('Shaira Morales', 5),
    ('Trisha Fernandez', 11),
    ('Trisha Molina', 9),
    ('Vincent Dela Cruz', 6);

-- Teams that actually have members, numbered 1..N for random picking.
CREATE TEMP TABLE _team_pool ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY t.id) AS rn, t.id AS team_id, t.name AS team_name
FROM technician_teams t
WHERE EXISTS (SELECT 1 FROM technician_team_members m WHERE m.team_id = t.id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _team_pool) THEN
        RAISE EXCEPTION 'No technician team with members found. Create a team under Technician first, then run this again.';
    END IF;
END $$;

-- Subscribers that still need an installation ticket, each with a random
-- team and random request / completion times around their installed_at.
CREATE TEMP TABLE _targets ON COMMIT DROP AS
SELECT
    s.id                                     AS subscriber_id,
    s.full_name,
    s.address,
    s.contact_number,
    s.latitude,
    s.longitude,
    s.nap_id,
    s.plan_type,
    s.installed_at,
    n.total_ports,
    1 + floor(random() * (SELECT count(*) FROM _team_pool))::int AS team_rn,
    (s.installed_at - (1 + floor(random() * 4)::int)) + time '09:00'
        + random() * interval '2 hours'      AS requested_at,
    s.installed_at + time '10:00'
        + random() * interval '8 hours'      AS completed_at,
    row_number() OVER (ORDER BY s.installed_at, s.id) AS seq
FROM subscribers s
LEFT JOIN naps n ON n.id = s.nap_id
WHERE s.status <> 'pending_review'
  AND s.installed_at IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM service_requests r
        WHERE r.subscriber_id = s.id AND r.request_type = 'new_installation'
  );

-- 4a. One completed "New Installation" ticket per subscriber (oldest first,
--     so the SO- numbers follow the installation dates).
INSERT INTO service_requests
    (request_type, subscriber_id, requested_nap_id, status, priority,
     latitude, longitude, full_name, address, contact_number, notes,
     plan_label, scheduled_date, created_at, updated_at)
SELECT
    'new_installation', g.subscriber_id, g.nap_id, 'completed', 'low',
    g.latitude, g.longitude, g.full_name, g.address, g.contact_number,
    'Assigned Team: ' || p.team_name,
    g.plan_type, g.installed_at, g.requested_at, g.completed_at
FROM _targets g
JOIN _team_pool p ON p.rn = g.team_rn
ORDER BY g.seq;

-- 4b. One completed assignment for every member of the chosen team.
INSERT INTO assignments
    (service_request_id, technician_id, assigned_at, status, port_number,
     completed_at, created_at, updated_at)
SELECT
    r.id,
    m.technician_id,
    g.requested_at + interval '30 minutes',
    'completed',
    CASE WHEN sp.port BETWEEN 1 AND g.total_ports THEN sp.port END,
    g.completed_at,
    g.requested_at,
    g.completed_at
FROM _targets g
JOIN _team_pool p                ON p.rn = g.team_rn
JOIN technician_team_members m   ON m.team_id = p.team_id
JOIN service_requests r          ON r.subscriber_id = g.subscriber_id
                                AND r.request_type = 'new_installation'
LEFT JOIN _sheet_ports sp        ON lower(btrim(sp.full_name)) = lower(btrim(g.full_name));

COMMIT;

-- ---------------------------------------------------------------------
-- Check (result of this last query is what the editor shows)
-- ---------------------------------------------------------------------
SELECT
    (SELECT count(*) FROM subscribers)                                                       AS subscribers,
    (SELECT count(*) FROM subscribers WHERE plan_type IS NULL OR btrim(plan_type) = '')      AS still_no_plan,
    (SELECT count(*) FROM subscribers WHERE installed_at IS NOT NULL)                        AS with_installed_date,
    (SELECT count(*) FROM service_requests WHERE request_type = 'new_installation')          AS installation_tickets,
    (SELECT count(*) FROM assignments a JOIN service_requests r ON r.id = a.service_request_id
        WHERE r.request_type = 'new_installation' AND a.port_number IS NOT NULL)             AS assignments_with_port,
    -- should be 0: two subscribers on the same NAP recorded on the same port
    (SELECT count(*) FROM (
        SELECT s.nap_id, a.port_number
        FROM assignments a
        JOIN service_requests r ON r.id = a.service_request_id AND r.request_type = 'new_installation'
        JOIN subscribers s      ON s.id = r.subscriber_id
        WHERE a.port_number IS NOT NULL AND s.nap_id IS NOT NULL
        GROUP BY s.nap_id, a.port_number
        HAVING count(DISTINCT s.id) > 1) x)                                                  AS port_conflicts;
