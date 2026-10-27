-- =====================================================================
-- NAP-IQ Database Schema -- PostgreSQL / Supabase edition
--
-- Equivalent of database/schema.sql (MySQL) for Supabase. Generated from
-- app/models.py, so it matches what the Flask app expects exactly.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run.   Run it ONCE on an empty database (CREATE TYPE has
-- no IF NOT EXISTS). To start over, drop the tables/types first.
--
-- The `geomap_default_*` columns that still exist in the MySQL schema.sql
-- are intentionally omitted: app/models.py no longer uses them.
-- =====================================================================

CREATE TYPE assignment_status AS ENUM (
    'assigned',
    'accepted',
    'in_progress',
    'completed',
    'cancelled'
);

CREATE TYPE issue_priority AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);

CREATE TYPE issue_status AS ENUM (
    'pending',
    'assigned',
    'in_progress',
    'resolved',
    'closed'
);

CREATE TYPE nap_status AS ENUM (
    'active',
    'inactive',
    'full',
    'maintenance'
);

CREATE TYPE notification_audience AS ENUM (
    'customer',
    'administrator'
);

CREATE TYPE notification_category AS ENUM (
    'service_request',
    'payment',
    'issue'
);

CREATE TYPE payment_method AS ENUM (
    'cash',
    'gcash',
    'bank_transfer',
    'other'
);

CREATE TYPE payment_status AS ENUM (
    'pending',
    'confirmed',
    'overdue',
    'voided'
);

CREATE TYPE service_request_priority AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);

CREATE TYPE service_request_status AS ENUM (
    'pending',
    'approved',
    'scheduled',
    'completed',
    'rejected',
    'closed'
);

CREATE TYPE service_request_type AS ENUM (
    'new_installation',
    'disconnection',
    'relocation',
    'upgrade',
    'add_nap'
);

CREATE TYPE subscriber_status AS ENUM (
    'active',
    'inactive',
    'disconnected',
    'pending_review'
);

CREATE TYPE technician_personnel_type AS ENUM (
    'technician',
    'field_assistant'
);

CREATE TYPE technician_status AS ENUM (
    'available',
    'busy',
    'offline'
);

CREATE TYPE user_role AS ENUM (
    'administrator',
    'technician',
    'field_assistant',
    'payment_collector',
    'user'
);

CREATE TYPE user_status AS ENUM (
    'active',
    'inactive',
    'suspended'
);

CREATE TYPE user_theme_preference AS ENUM (
    'light',
    'dark'
);

CREATE TABLE app_settings (
    id integer NOT NULL,
    session_timeout_minutes integer NOT NULL,
    default_nap_total_ports integer NOT NULL,
    nap_connection_radius_meters integer NOT NULL,
    updated_by_id integer,
    updated_at timestamp without time zone NOT NULL
);

CREATE TABLE assignments (
    id integer NOT NULL,
    technical_issue_id integer,
    service_request_id integer,
    technician_id integer NOT NULL,
    assigned_at timestamp without time zone NOT NULL,
    status assignment_status NOT NULL,
    dispatch_score numeric(5,2),
    port_number integer,
    resolution_notes text,
    photo_filename character varying(255),
    signature_filename character varying(255),
    pin_latitude numeric(10,7),
    pin_longitude numeric(10,7),
    cable_path_points text,
    completed_at timestamp without time zone,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE assignments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE assignments_id_seq OWNED BY assignments.id;

CREATE TABLE cable_paths (
    id integer NOT NULL,
    subscriber_id integer NOT NULL,
    nap_id integer NOT NULL,
    source_assignment_id integer,
    points text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE cable_paths_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE cable_paths_id_seq OWNED BY cable_paths.id;

CREATE TABLE email_verifications (
    id integer NOT NULL,
    email character varying(100) NOT NULL,
    purpose character varying(30) NOT NULL,
    code character varying(6) NOT NULL,
    attempts integer NOT NULL,
    is_verified boolean NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE email_verifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE email_verifications_id_seq OWNED BY email_verifications.id;

CREATE TABLE naps (
    id integer NOT NULL,
    nap_code character varying(20) NOT NULL,
    name character varying(100) NOT NULL,
    address character varying(255),
    latitude numeric(10,7) NOT NULL,
    longitude numeric(10,7) NOT NULL,
    total_ports integer NOT NULL,
    used_ports integer NOT NULL,
    available_ports integer NOT NULL,
    status nap_status NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE naps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE naps_id_seq OWNED BY naps.id;

CREATE TABLE notifications (
    id integer NOT NULL,
    audience notification_audience NOT NULL,
    user_id integer,
    category notification_category NOT NULL,
    title character varying(150) NOT NULL,
    message text NOT NULL,
    entity_type character varying(30),
    entity_id integer,
    is_read boolean NOT NULL,
    created_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE notifications_id_seq OWNED BY notifications.id;

CREATE TABLE payments (
    id integer NOT NULL,
    subscriber_id integer NOT NULL,
    collector_id integer,
    amount numeric(10,2) NOT NULL,
    payment_method payment_method NOT NULL,
    payment_date date NOT NULL,
    reference_number character varying(50),
    remarks character varying(500),
    status payment_status NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE payments_id_seq OWNED BY payments.id;

CREATE TABLE plans (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    monthly_fee numeric(10,2),
    created_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE plans_id_seq OWNED BY plans.id;

CREATE TABLE revoked_tokens (
    id integer NOT NULL,
    jti character varying(36) NOT NULL,
    revoked_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE revoked_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE revoked_tokens_id_seq OWNED BY revoked_tokens.id;

CREATE TABLE service_requests (
    id integer NOT NULL,
    request_type service_request_type NOT NULL,
    subscriber_id integer,
    requested_nap_id integer,
    status service_request_status NOT NULL,
    priority service_request_priority,
    latitude numeric(10,7),
    longitude numeric(10,7),
    full_name character varying(150),
    address character varying(255),
    contact_number character varying(20),
    notes text,
    plan_label character varying(150),
    scheduled_date date,
    port_capacity integer,
    planned_nap_code character varying(20),
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE service_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE service_requests_id_seq OWNED BY service_requests.id;

CREATE TABLE subscribers (
    id integer NOT NULL,
    subscriber_code character varying(20) NOT NULL,
    full_name character varying(100) NOT NULL,
    address character varying(255),
    latitude numeric(10,7),
    longitude numeric(10,7),
    contact_number character varying(20),
    email character varying(100),
    plan_type character varying(50),
    nap_id integer,
    user_id integer,
    status subscriber_status NOT NULL,
    installed_at date,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE subscribers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE subscribers_id_seq OWNED BY subscribers.id;

CREATE TABLE technical_issues (
    id integer NOT NULL,
    issue_code character varying(20),
    issue_type character varying(50) NOT NULL,
    description text,
    priority issue_priority NOT NULL,
    status issue_status NOT NULL,
    address character varying(255),
    latitude numeric(10,7),
    longitude numeric(10,7),
    photo_filename character varying(255),
    subscriber_id integer NOT NULL,
    nap_id integer,
    parent_issue_id integer,
    proof_photo character varying(255),
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE technical_issues_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE technical_issues_id_seq OWNED BY technical_issues.id;

CREATE TABLE technicians (
    id integer NOT NULL,
    user_id integer,
    full_name character varying(100) NOT NULL,
    contact_number character varying(20),
    personnel_type technician_personnel_type NOT NULL,
    current_latitude numeric(10,7),
    current_longitude numeric(10,7),
    status technician_status NOT NULL,
    resolved_issues_count integer NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE technicians_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE technicians_id_seq OWNED BY technicians.id;

CREATE TABLE users (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(100) NOT NULL,
    role user_role NOT NULL,
    email character varying(100),
    phone_number character varying(20),
    coverage_area character varying(255),
    status user_status NOT NULL,
    theme_preference user_theme_preference DEFAULT 'light'::user_theme_preference NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);

CREATE SEQUENCE users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE users_id_seq OWNED BY users.id;

ALTER TABLE ONLY assignments ALTER COLUMN id SET DEFAULT nextval('assignments_id_seq'::regclass);

ALTER TABLE ONLY cable_paths ALTER COLUMN id SET DEFAULT nextval('cable_paths_id_seq'::regclass);

ALTER TABLE ONLY email_verifications ALTER COLUMN id SET DEFAULT nextval('email_verifications_id_seq'::regclass);

ALTER TABLE ONLY naps ALTER COLUMN id SET DEFAULT nextval('naps_id_seq'::regclass);

ALTER TABLE ONLY notifications ALTER COLUMN id SET DEFAULT nextval('notifications_id_seq'::regclass);

ALTER TABLE ONLY payments ALTER COLUMN id SET DEFAULT nextval('payments_id_seq'::regclass);

ALTER TABLE ONLY plans ALTER COLUMN id SET DEFAULT nextval('plans_id_seq'::regclass);

ALTER TABLE ONLY revoked_tokens ALTER COLUMN id SET DEFAULT nextval('revoked_tokens_id_seq'::regclass);

ALTER TABLE ONLY service_requests ALTER COLUMN id SET DEFAULT nextval('service_requests_id_seq'::regclass);

ALTER TABLE ONLY subscribers ALTER COLUMN id SET DEFAULT nextval('subscribers_id_seq'::regclass);

ALTER TABLE ONLY technical_issues ALTER COLUMN id SET DEFAULT nextval('technical_issues_id_seq'::regclass);

ALTER TABLE ONLY technicians ALTER COLUMN id SET DEFAULT nextval('technicians_id_seq'::regclass);

ALTER TABLE ONLY users ALTER COLUMN id SET DEFAULT nextval('users_id_seq'::regclass);

ALTER TABLE ONLY app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY assignments
    ADD CONSTRAINT assignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY cable_paths
    ADD CONSTRAINT cable_paths_pkey PRIMARY KEY (id);

ALTER TABLE ONLY cable_paths
    ADD CONSTRAINT cable_paths_subscriber_id_key UNIQUE (subscriber_id);

ALTER TABLE ONLY email_verifications
    ADD CONSTRAINT email_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY naps
    ADD CONSTRAINT naps_nap_code_key UNIQUE (nap_code);

ALTER TABLE ONLY naps
    ADD CONSTRAINT naps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY plans
    ADD CONSTRAINT plans_name_key UNIQUE (name);

ALTER TABLE ONLY plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY revoked_tokens
    ADD CONSTRAINT revoked_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY service_requests
    ADD CONSTRAINT service_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY subscribers
    ADD CONSTRAINT subscribers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY subscribers
    ADD CONSTRAINT subscribers_subscriber_code_key UNIQUE (subscriber_code);

ALTER TABLE ONLY subscribers
    ADD CONSTRAINT subscribers_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY technical_issues
    ADD CONSTRAINT technical_issues_pkey PRIMARY KEY (id);

ALTER TABLE ONLY technicians
    ADD CONSTRAINT technicians_pkey PRIMARY KEY (id);

ALTER TABLE ONLY technicians
    ADD CONSTRAINT technicians_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_username_key UNIQUE (username);

CREATE INDEX ix_email_verifications_email ON email_verifications USING btree (email);

CREATE UNIQUE INDEX ix_revoked_tokens_jti ON revoked_tokens USING btree (jti);

ALTER TABLE ONLY app_settings
    ADD CONSTRAINT app_settings_updated_by_id_fkey FOREIGN KEY (updated_by_id) REFERENCES users(id);

ALTER TABLE ONLY assignments
    ADD CONSTRAINT assignments_service_request_id_fkey FOREIGN KEY (service_request_id) REFERENCES service_requests(id);

ALTER TABLE ONLY assignments
    ADD CONSTRAINT assignments_technical_issue_id_fkey FOREIGN KEY (technical_issue_id) REFERENCES technical_issues(id);

ALTER TABLE ONLY assignments
    ADD CONSTRAINT assignments_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES technicians(id);

ALTER TABLE ONLY cable_paths
    ADD CONSTRAINT cable_paths_nap_id_fkey FOREIGN KEY (nap_id) REFERENCES naps(id);

ALTER TABLE ONLY cable_paths
    ADD CONSTRAINT cable_paths_source_assignment_id_fkey FOREIGN KEY (source_assignment_id) REFERENCES assignments(id);

ALTER TABLE ONLY cable_paths
    ADD CONSTRAINT cable_paths_subscriber_id_fkey FOREIGN KEY (subscriber_id) REFERENCES subscribers(id);

ALTER TABLE ONLY notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY payments
    ADD CONSTRAINT payments_collector_id_fkey FOREIGN KEY (collector_id) REFERENCES users(id);

ALTER TABLE ONLY payments
    ADD CONSTRAINT payments_subscriber_id_fkey FOREIGN KEY (subscriber_id) REFERENCES subscribers(id);

ALTER TABLE ONLY service_requests
    ADD CONSTRAINT service_requests_requested_nap_id_fkey FOREIGN KEY (requested_nap_id) REFERENCES naps(id);

ALTER TABLE ONLY service_requests
    ADD CONSTRAINT service_requests_subscriber_id_fkey FOREIGN KEY (subscriber_id) REFERENCES subscribers(id);

ALTER TABLE ONLY subscribers
    ADD CONSTRAINT subscribers_nap_id_fkey FOREIGN KEY (nap_id) REFERENCES naps(id);

ALTER TABLE ONLY subscribers
    ADD CONSTRAINT subscribers_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY technical_issues
    ADD CONSTRAINT technical_issues_nap_id_fkey FOREIGN KEY (nap_id) REFERENCES naps(id);

ALTER TABLE ONLY technical_issues
    ADD CONSTRAINT technical_issues_parent_issue_id_fkey FOREIGN KEY (parent_issue_id) REFERENCES technical_issues(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY technical_issues
    ADD CONSTRAINT technical_issues_subscriber_id_fkey FOREIGN KEY (subscriber_id) REFERENCES subscribers(id);

ALTER TABLE ONLY technicians
    ADD CONSTRAINT technicians_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

-- ---------------------------------------------------------------------
-- Column defaults carried over from the MySQL schema.sql. The ORM sets
-- most of these itself, but database/seed_postgres.sql, the data-migration
-- script and any manual INSERT rely on them being enforced by the database.
-- (MySQL's "ON UPDATE CURRENT_TIMESTAMP" has no Postgres equivalent; the
-- app sets updated_at itself via SQLAlchemy's onupdate.)
-- ---------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE naps ALTER COLUMN total_ports SET DEFAULT 8;
ALTER TABLE naps ALTER COLUMN used_ports SET DEFAULT 0;
ALTER TABLE naps ALTER COLUMN available_ports SET DEFAULT 8;
ALTER TABLE naps ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE naps ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE naps ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE subscribers ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE subscribers ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE subscribers ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE technicians ALTER COLUMN personnel_type SET DEFAULT 'technician';
ALTER TABLE technicians ALTER COLUMN status SET DEFAULT 'available';
ALTER TABLE technicians ALTER COLUMN resolved_issues_count SET DEFAULT 0;
ALTER TABLE technicians ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE technicians ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE technical_issues ALTER COLUMN priority SET DEFAULT 'medium';
ALTER TABLE technical_issues ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE technical_issues ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE technical_issues ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE service_requests ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE service_requests ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE service_requests ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE payments ALTER COLUMN payment_method SET DEFAULT 'cash';
ALTER TABLE payments ALTER COLUMN status SET DEFAULT 'confirmed';
ALTER TABLE payments ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE payments ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE assignments ALTER COLUMN assigned_at SET DEFAULT now();
ALTER TABLE assignments ALTER COLUMN status SET DEFAULT 'assigned';
ALTER TABLE assignments ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE assignments ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE cable_paths ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE cable_paths ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE app_settings ALTER COLUMN session_timeout_minutes SET DEFAULT 60;
ALTER TABLE app_settings ALTER COLUMN default_nap_total_ports SET DEFAULT 8;
ALTER TABLE app_settings ALTER COLUMN nap_connection_radius_meters SET DEFAULT 0;
ALTER TABLE app_settings ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE plans ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE notifications ALTER COLUMN is_read SET DEFAULT FALSE;
ALTER TABLE notifications ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE revoked_tokens ALTER COLUMN revoked_at SET DEFAULT now();
ALTER TABLE email_verifications ALTER COLUMN purpose SET DEFAULT 'registration';
ALTER TABLE email_verifications ALTER COLUMN attempts SET DEFAULT 0;
ALTER TABLE email_verifications ALTER COLUMN is_verified SET DEFAULT FALSE;
ALTER TABLE email_verifications ALTER COLUMN created_at SET DEFAULT now();

-- ---------------------------------------------------------------------
-- Singleton settings row (MySQL schema.sql: INSERT IGNORE INTO app_settings)
-- ---------------------------------------------------------------------
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Security: lock the Supabase auto-generated REST/GraphQL API.
-- Supabase exposes every table in the `public` schema to anyone holding
-- the (public) anon key unless Row Level Security is on. This app talks
-- to the database directly as the `postgres` role (which bypasses RLS),
-- so enabling RLS with no policies blocks the public API completely
-- without affecting the app.
-- ---------------------------------------------------------------------
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cable_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE naps ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE technical_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE technicians ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
