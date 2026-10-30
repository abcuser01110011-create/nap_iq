-- One-off data fix (MySQL). Run once.
-- See fix_team_assignments_postgres.sql for what this does.

UPDATE assignments a
JOIN assignments b
  ON b.technical_issue_id = a.technical_issue_id
 AND b.id <> a.id
 AND b.status = 'in_progress'
SET a.status = 'in_progress'
WHERE a.status IN ('assigned', 'accepted')
  AND a.technical_issue_id IS NOT NULL;

UPDATE assignments a
JOIN assignments b
  ON b.service_request_id = a.service_request_id
 AND b.id <> a.id
 AND b.status = 'in_progress'
SET a.status = 'in_progress'
WHERE a.status IN ('accepted', 'assigned')
  AND a.service_request_id IS NOT NULL;

UPDATE technicians t
SET t.status = 'busy'
WHERE t.status <> 'offline'
  AND EXISTS (
    SELECT 1 FROM assignments a
    WHERE a.technician_id = t.id AND a.status = 'in_progress'
  );
