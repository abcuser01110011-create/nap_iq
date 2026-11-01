-- =====================================================================
-- NAP-IQ | One-off data fix (PostgreSQL / Supabase)
-- Rewrites EXISTING administrator notifications that were saved with the
-- customer's wording ("Your reported issue is now ...", "You're
-- connected!") into proper admin wording. New notifications are already
-- correct after updating the app files. Customer notifications are not
-- touched. Safe to run more than once.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
-- =====================================================================
BEGIN;

-- Technical issue status changes
UPDATE notifications n
SET message = format('Technical issue %s (%s) is now ''%s''.',
                     substring(n.title from '^Technical issue (.+) — '),
                     COALESCE(t.issue_type, 'issue'),
                     split_part(n.title, ' — ', 2))
FROM technical_issues t
WHERE n.audience = 'administrator'
  AND n.entity_type = 'issue'
  AND t.id = n.entity_id
  AND n.message LIKE 'Your reported issue is now%';

-- Service request status changes
UPDATE notifications n
SET message = format('Service request %s (%s) is now ''%s''.',
                     substring(n.title from '^Service request (.+) — '),
                     substring(n.message from '^Your (.+) request is now'),
                     split_part(n.title, ' — ', 2))
WHERE n.audience = 'administrator'
  AND n.entity_type = 'service_request'
  AND n.message LIKE 'Your % request is now%';

-- "You're connected!" (installation completed)
UPDATE notifications n
SET title   = 'Installation completed — ' || substring(n.message from '— (\S+) is now active'),
    message = COALESCE(s.full_name, 'Subscriber') || ' (' || substring(n.message from '— (\S+) is now active')
              || ') is now connected and active.'
FROM subscribers s
WHERE n.audience = 'administrator'
  AND n.title = 'You''re connected!'
  AND s.subscriber_code = substring(n.message from '— (\S+) is now active');

COMMIT;
