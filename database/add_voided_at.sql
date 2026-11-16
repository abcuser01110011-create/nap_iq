-- Void ticket feature: run ONCE on the database (MySQL).
ALTER TABLE technical_issues ADD COLUMN voided_at DATETIME NULL;
ALTER TABLE service_requests ADD COLUMN voided_at DATETIME NULL;
