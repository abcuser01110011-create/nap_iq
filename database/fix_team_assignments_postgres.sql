-- One-off data fix (PostgreSQL / Supabase). Run once in the SQL Editor.
-- Team tickets create one assignment per member; the app now keeps them in
-- sync going forward. This brings tickets that were started BEFORE that
-- change in line: any still-waiting teammate copy becomes 'in_progress'
-- when another copy of the same ticket is already in progress.

UPDATE assignments a
SET status = 'in_progress'
WHERE a.status IN ('assigned', 'accepted')
  AND a.technical_issue_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assignments b
    WHERE b.technical_issue_id = a.technical_issue_id
      AND b.id <> a.id
      AND b.status = 'in_progress'
  );

-- Same for installation (service request) assignments.
UPDATE assignments a
SET status = 'in_progress'
WHERE a.status IN ('assigned', 'accepted')
  AND a.service_request_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assignments b
    WHERE b.service_request_id = a.service_request_id
      AND b.id <> a.id
      AND b.status = 'in_progress'
  );

-- Mark technicians with an in-progress job as busy.
UPDATE technicians t
SET status = 'busy'
WHERE t.status <> 'offline'
  AND EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.technician_id = t.id AND a.status = 'in_progress'
  );
