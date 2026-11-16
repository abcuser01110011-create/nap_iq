-- Void ticket feature: run ONCE on the database (Postgres / Supabase SQL editor).
ALTER TABLE technical_issues ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP NULL;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP NULL;
