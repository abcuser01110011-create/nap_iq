-- One-time cleanup (PostgreSQL / Supabase).
-- Payments recorded by a payment collector are now saved as 'confirmed'
-- straight away (see collector.record_payment). Older ones that were saved
-- as 'pending' before that are still waiting for an admin, so they show as
-- unpaid on the collector side and add to the Payments badge. This marks
-- them confirmed. Online HitPay payments (no collector) and payments an
-- administrator entered are NOT touched.

-- 1) Preview what will change:
SELECT p.id, p.subscriber_id, p.amount, p.payment_date, u.username AS collector
FROM payments p
JOIN users u ON u.id = p.collector_id
WHERE p.status = 'pending' AND u.role = 'payment_collector'
ORDER BY p.id;

-- 2) Apply:
UPDATE payments
SET status = 'confirmed', updated_at = NOW()
WHERE status = 'pending'
  AND collector_id IN (SELECT id FROM users WHERE role = 'payment_collector');
