-- =====================================================================
-- NAP-IQ Database Schema
-- Run this file in MySQL to create the `nap_iq` database and its
-- initial 8 tables. This is the source of truth for the database
-- structure; app/models.py mirrors this schema for use inside Flask.
--
-- Usage (MySQL command line):
--   mysql -u root -p < database/schema.sql
-- =====================================================================

CREATE DATABASE IF NOT EXISTS nap_iq
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE nap_iq;

-- ---------------------------------------------------------------------
-- users: system accounts (administrator, field assistant, payment collector)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(50)  NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(100) NOT NULL,
    role            ENUM('administrator', 'field_assistant', 'payment_collector', 'user') NOT NULL,
    email           VARCHAR(100) UNIQUE,
    phone_number    VARCHAR(20),
    status          ENUM('active', 'inactive', 'suspended') NOT NULL DEFAULT 'active',
    -- Phase 24: Settings > Display Settings' Dark Mode toggle, saved per
    -- account (not per browser) so it follows the user across devices.
    -- Defaults to 'light' for every role. The login screen never reads
    -- this column -- it always renders in light mode.
    theme_preference ENUM('light', 'dark') NOT NULL DEFAULT 'light',
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- For an already-provisioned database (CREATE TABLE IF NOT EXISTS above
-- won't retrofit an existing install):
--   ALTER TABLE users
--       ADD COLUMN theme_preference ENUM('light', 'dark') NOT NULL DEFAULT 'light' AFTER status;

-- ---------------------------------------------------------------------
-- naps: Network Access Points plotted on the GeoMap
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS naps (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    nap_code        VARCHAR(20)  NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,
    address         VARCHAR(255),
    latitude        DECIMAL(10,7) NOT NULL,
    longitude       DECIMAL(10,7) NOT NULL,
    total_ports     INT NOT NULL DEFAULT 8,
    used_ports      INT NOT NULL DEFAULT 0,
    available_ports INT NOT NULL DEFAULT 8,
    status          ENUM('active', 'inactive', 'full', 'maintenance') NOT NULL DEFAULT 'active',
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT chk_naps_ports CHECK (used_ports <= total_ports)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- subscribers: ISP customers connected to (or applying for) a NAP
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscribers (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    subscriber_code VARCHAR(20)  NOT NULL UNIQUE,
    full_name       VARCHAR(100) NOT NULL,
    address         VARCHAR(255),
    latitude        DECIMAL(10,7),
    longitude       DECIMAL(10,7),
    contact_number  VARCHAR(20),
    email           VARCHAR(100),
    plan_type       VARCHAR(50),
    nap_id          INT,
    -- Phase 10: links this subscriber (billing/service record) to the
    -- `users` login account they sign in with, if any. Nullable + UNIQUE:
    -- a subscriber doesn't have to have a portal login yet (staff can
    -- create the subscriber first and link/create the account later),
    -- and one user account can link to at most one subscriber record.
    user_id         INT UNIQUE,
    status          ENUM('active', 'inactive', 'disconnected') NOT NULL DEFAULT 'active',
    installed_at    DATE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_subscribers_nap
        FOREIGN KEY (nap_id) REFERENCES naps(id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_subscribers_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- technicians: technician profiles used by the dispatch module
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS technicians (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    user_id              INT UNIQUE,
    full_name            VARCHAR(100) NOT NULL,
    contact_number       VARCHAR(20),
    personnel_type       ENUM('technician', 'field_assistant') NOT NULL DEFAULT 'technician',
    current_latitude     DECIMAL(10,7),
    current_longitude    DECIMAL(10,7),
    status               ENUM('available', 'busy', 'offline') NOT NULL DEFAULT 'available',
    resolved_issues_count INT NOT NULL DEFAULT 0,
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                             ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_technicians_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- technical_issues: subscriber-reported technical complaints
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS technical_issues (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    issue_code      VARCHAR(20) UNIQUE,
    issue_type      VARCHAR(50)  NOT NULL,
    description     TEXT,
    priority        ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
    status          ENUM('pending', 'assigned', 'in_progress', 'resolved', 'closed')
                        NOT NULL DEFAULT 'pending',
    address         VARCHAR(255),
    latitude        DECIMAL(10,7),
    longitude       DECIMAL(10,7),
    subscriber_id   INT NOT NULL,
    nap_id          INT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_issues_subscriber
        FOREIGN KEY (subscriber_id) REFERENCES subscribers(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_issues_nap
        FOREIGN KEY (nap_id) REFERENCES naps(id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- service_requests: new installation / disconnection / relocation / upgrade / add_nap
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_requests (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    -- 'add_nap': a ticket asking a field assistant to install a brand
    -- new NAP, created from the GeoMap "+ Tickets" quick-create modal.
    -- See app/models.py's ServiceRequest.request_type comment.
    request_type      ENUM('new_installation', 'disconnection', 'relocation', 'upgrade', 'add_nap')
                          NOT NULL,
    subscriber_id     INT,
    requested_nap_id  INT,
    status            ENUM('pending', 'approved', 'scheduled', 'completed', 'rejected')
                          NOT NULL DEFAULT 'pending',
    -- Phase 22 (phase_11.pdf "nearest available NAP recommendation"):
    -- the customer/proposed-installation coordinates the recommendation
    -- is computed from. Nullable — an existing request created before
    -- this phase, or one an administrator hasn't pinned a location for
    -- yet, simply has no coordinates and can't be run through the
    -- recommender until one is set (see app/nap_recommendation.py and
    -- PHASE22_NOTES.md). This is the one schema change this phase
    -- needed — see PHASE22_NOTES.md's "Why this schema change" section
    -- for why no existing column already covered it.
    latitude          DECIMAL(10,7),
    longitude         DECIMAL(10,7),
    -- Walk-in applicant details — see the matching comment on
    -- app/models.py's ServiceRequest. Only populated for a
    -- new_installation request with no subscriber_id yet.
    full_name         VARCHAR(150),
    address           VARCHAR(255),
    contact_number    VARCHAR(20),
    notes             TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_requests_subscriber
        FOREIGN KEY (subscriber_id) REFERENCES subscribers(id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_requests_nap
        FOREIGN KEY (requested_nap_id) REFERENCES naps(id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- payments: subscriber payment records
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    subscriber_id     INT NOT NULL,
    collector_id      INT,
    amount            DECIMAL(10,2) NOT NULL,
    payment_method    ENUM('cash', 'gcash', 'bank_transfer', 'other') NOT NULL DEFAULT 'cash',
    payment_date      DATE NOT NULL,
    reference_number  VARCHAR(50),
    status            ENUM('pending', 'confirmed', 'overdue', 'voided') NOT NULL DEFAULT 'confirmed',
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_payments_subscriber
        FOREIGN KEY (subscriber_id) REFERENCES subscribers(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_payments_collector
        FOREIGN KEY (collector_id) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- assignments: links a technical_issue to the technician dispatched to it
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- assignments: links a technical_issue OR a service_request (Phase 28:
-- installs) to the technician dispatched to it. Exactly one of
-- technical_issue_id / service_request_id is set on any given row —
-- an app-layer rule (see Assignment._check_exactly_one_source in
-- app/models.py), not a DB CHECK, so both columns stay plain nullable
-- FKs here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignments (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    technical_issue_id    INT NULL,
    -- Phase 28: the install this assignment dispatches a technician
    -- for, when this row is an installation rather than a repair.
    service_request_id    INT NULL,
    technician_id         INT NOT NULL,
    assigned_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status                ENUM('assigned', 'accepted', 'in_progress', 'completed', 'cancelled')
                              NOT NULL DEFAULT 'assigned',
    dispatch_score        DECIMAL(5,2),
    -- Phase 20 (phase_8.pdf "Add resolution notes" / "Save resolution
    -- notes"): free-text notes the technician records against their
    -- own assignment — what was found, what was done, parts used,
    -- follow-up needed, etc. Kept on the assignment row (not the
    -- issue) so reassignment history stays intact per-technician,
    -- same reasoning as the rest of this table's design.
    resolution_notes      TEXT NULL,
    -- Phase 25 (mobile technician app): filename (in practice, the
    -- full Cloudinary secure_url — see app/models.py's comment on
    -- this column) of the technician's required completion photo.
    photo_filename        VARCHAR(255) NULL,
    -- Phase 28: an install's required customer sign-off, stored the
    -- same way as photo_filename above. NULL for repair assignments.
    -- No longer required for completion -- see pin_latitude /
    -- pin_longitude below.
    signature_filename     VARCHAR(255) NULL,
    -- Replaces the customer-signature requirement above: the
    -- technician's own GPS fix, captured on-device (same "Track My
    -- Location" pattern as the customer app's ApplyForServiceScreen).
    -- NULL for repair assignments.
    pin_latitude          DECIMAL(10,7) NULL,
    pin_longitude         DECIMAL(10,7) NULL,
    completed_at          TIMESTAMP NULL,
    created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_assignments_issue
        FOREIGN KEY (technical_issue_id) REFERENCES technical_issues(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_assignments_request
        FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_assignments_technician
        FOREIGN KEY (technician_id) REFERENCES technicians(id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- app_settings: singleton row of admin-configurable app-level config
-- (Phase 15). Always exactly one row, id=1 — a small, typed-column
-- table (matching this schema's existing style) rather than a
-- generic key/value store, since the set of settings is small and
-- known ahead of time.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
    id                        INT PRIMARY KEY DEFAULT 1,
    session_timeout_minutes   INT NOT NULL DEFAULT 60,
    default_nap_total_ports   INT NOT NULL DEFAULT 8,

    -- Max Connection Radius, meters (Settings > App Settings): caps
    -- how far a customer location can be from a NAP for that NAP to
    -- be recommended/auto-assigned (app/nap_recommendation.py). 0 =
    -- no limit (default; opt-in feature, no behavior change until an
    -- administrator sets it).
    nap_connection_radius_meters INT NOT NULL DEFAULT 0,

    -- Default GeoMap Filters (Settings > App Settings): what the
    -- GeoMap's Layers/Filters dropdown controls (naps/map.html) start
    -- set to when the page loads. Every control stays fully
    -- toggleable per-visit for every role no matter what these say --
    -- these only decide the starting point. Defaults below reproduce
    -- the hard-coded checked/selected attributes naps/map.html
    -- shipped with before this setting existed.
    geomap_default_show_naps               BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_show_issues             BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_show_subscribers        BOOLEAN NOT NULL DEFAULT FALSE,

    geomap_default_status_active           BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_status_inactive         BOOLEAN NOT NULL DEFAULT FALSE,
    geomap_default_status_maintenance      BOOLEAN NOT NULL DEFAULT FALSE,
    geomap_default_status_full             BOOLEAN NOT NULL DEFAULT FALSE,
    geomap_default_ports_filter            ENUM('all', 'available', 'full') NOT NULL DEFAULT 'all',

    geomap_default_issue_status_pending      BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_issue_status_assigned     BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_issue_status_in_progress  BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_issue_status_resolved     BOOLEAN NOT NULL DEFAULT FALSE,
    geomap_default_issue_status_closed       BOOLEAN NOT NULL DEFAULT FALSE,

    geomap_default_issue_priority_low        BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_issue_priority_medium     BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_issue_priority_high       BOOLEAN NOT NULL DEFAULT TRUE,
    geomap_default_issue_priority_critical   BOOLEAN NOT NULL DEFAULT TRUE,

    updated_by_id             INT,
    updated_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT chk_app_settings_singleton CHECK (id = 1),
    CONSTRAINT fk_app_settings_updated_by
        FOREIGN KEY (updated_by_id) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

INSERT IGNORE INTO app_settings (id) VALUES (1);

-- For an already-provisioned database (CREATE TABLE IF NOT EXISTS above
-- won't retrofit an existing install):
--   ALTER TABLE app_settings
--       ADD COLUMN geomap_default_show_naps BOOLEAN NOT NULL DEFAULT TRUE AFTER default_nap_total_ports,
--       ADD COLUMN geomap_default_show_issues BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_show_naps,
--       ADD COLUMN geomap_default_show_subscribers BOOLEAN NOT NULL DEFAULT FALSE AFTER geomap_default_show_issues,
--       ADD COLUMN geomap_default_status_active BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_show_subscribers,
--       ADD COLUMN geomap_default_status_inactive BOOLEAN NOT NULL DEFAULT FALSE AFTER geomap_default_status_active,
--       ADD COLUMN geomap_default_status_maintenance BOOLEAN NOT NULL DEFAULT FALSE AFTER geomap_default_status_inactive,
--       ADD COLUMN geomap_default_status_full BOOLEAN NOT NULL DEFAULT FALSE AFTER geomap_default_status_maintenance,
--       ADD COLUMN geomap_default_ports_filter ENUM('all', 'available', 'full') NOT NULL DEFAULT 'all' AFTER geomap_default_status_full,
--       ADD COLUMN geomap_default_issue_status_pending BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_ports_filter,
--       ADD COLUMN geomap_default_issue_status_assigned BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_issue_status_pending,
--       ADD COLUMN geomap_default_issue_status_in_progress BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_issue_status_assigned,
--       ADD COLUMN geomap_default_issue_status_resolved BOOLEAN NOT NULL DEFAULT FALSE AFTER geomap_default_issue_status_in_progress,
--       ADD COLUMN geomap_default_issue_status_closed BOOLEAN NOT NULL DEFAULT FALSE AFTER geomap_default_issue_status_resolved,
--       ADD COLUMN geomap_default_issue_priority_low BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_issue_status_closed,
--       ADD COLUMN geomap_default_issue_priority_medium BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_issue_priority_low,
--       ADD COLUMN geomap_default_issue_priority_high BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_issue_priority_medium,
--       ADD COLUMN geomap_default_issue_priority_critical BOOLEAN NOT NULL DEFAULT TRUE AFTER geomap_default_issue_priority_high;

-- For a database that already ran the ALTER TABLE block above (i.e.
-- already has the geomap_default_* columns) but predates the Max
-- Connection Radius setting:
--   ALTER TABLE app_settings
--       ADD COLUMN nap_connection_radius_meters INT NOT NULL DEFAULT 0 AFTER default_nap_total_ports;


-- ---------------------------------------------------------------------
-- plans: admin-managed list of subscription plan names (Settings >
-- App Settings > Plans). Supplies the <datalist> suggestions offered
-- while typing a subscriber's Plan Type (subscribers.plan_type stays
-- free text, NOT a foreign key to this table -- see the Plan model's
-- docstring in app/models.py for why). A plain, hard-deletable lookup
-- table: removing a row here never touches any subscriber that
-- already used that plan name.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- notifications: system-generated notices for service request status
-- changes, payment due/overdue, and technical issue status changes
-- (Phase 17). See the module-level comment above the Notification
-- model in app/models.py for the audience/read-state model this
-- mirrors — a single event can produce up to two rows: one
-- 'customer' row (user_id set, the affected subscriber's login) and
-- one 'administrator' row (user_id NULL, system-wide).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    audience        ENUM('customer', 'administrator') NOT NULL,
    user_id         INT NULL,
    category        ENUM('service_request', 'payment', 'issue') NOT NULL,
    title           VARCHAR(150) NOT NULL,
    message         TEXT NOT NULL,
    entity_type     VARCHAR(30),
    entity_id       INT,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_notifications_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- revoked_tokens: JWTs explicitly logged out via POST /api/v1/auth/logout
-- (Phase 25 — mobile API auth for the Technician and Customer apps).
-- A JWT is normally self-contained and stays valid until it expires;
-- recording a revoked token's jti here (checked on every request by
-- the token_in_blocklist_loader in app/__init__.py) is what makes
-- logout actually invalidate it immediately. Not tied to any user
-- row by foreign key -- a jti alone is enough to check, and the token
-- itself already carries the user id it was issued to. See
-- RevokedToken's docstring in app/models.py.
--
-- Safe to periodically purge rows older than JWT_REFRESH_TOKEN_EXPIRES
-- (app/config.py) -- an expired token is already rejected by expiry
-- alone even if its jti were purged from here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revoked_tokens (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    jti             VARCHAR(36) NOT NULL UNIQUE,
    revoked_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- email_verifications: one-time codes sent to an email address to
-- verify it during mobile self-registration (Gmail-sent OTP flow —
-- see app/email_utils.py and app/routes/api_v1/auth.py). Deliberately
-- not tied to a users row: the address is verified BEFORE any account
-- exists. Looked up by (email, purpose) instead of a foreign key.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    email           VARCHAR(100) NOT NULL,
    purpose         VARCHAR(30) NOT NULL DEFAULT 'registration',
    code            VARCHAR(6) NOT NULL,
    attempts        INT NOT NULL DEFAULT 0,
    is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at      TIMESTAMP NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_email_verifications_email (email)
) ENGINE=InnoDB;
