-- Technician teams (Technician tab > Create Team)
-- Run ONCE on your database. Pick the section for your database.

-- =====================================================================
-- PostgreSQL / Supabase
-- =====================================================================
CREATE TABLE IF NOT EXISTS technician_teams (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    description VARCHAR(255),
    leader_id   INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS technician_team_members (
    team_id       INTEGER NOT NULL REFERENCES technician_teams(id) ON DELETE CASCADE,
    technician_id INTEGER NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, technician_id)
);

-- =====================================================================
-- MySQL (the dialect database/schema.sql uses) -- run this instead
-- =====================================================================
-- CREATE TABLE IF NOT EXISTS technician_teams (
--     id          INT AUTO_INCREMENT PRIMARY KEY,
--     name        VARCHAR(100) NOT NULL UNIQUE,
--     description VARCHAR(255),
--     leader_id   INT NULL,
--     created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
--     updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
--     CONSTRAINT fk_team_leader FOREIGN KEY (leader_id) REFERENCES technicians(id) ON DELETE SET NULL
-- ) ENGINE=InnoDB;
--
-- CREATE TABLE IF NOT EXISTS technician_team_members (
--     team_id       INT NOT NULL,
--     technician_id INT NOT NULL,
--     PRIMARY KEY (team_id, technician_id),
--     CONSTRAINT fk_tm_team FOREIGN KEY (team_id) REFERENCES technician_teams(id) ON DELETE CASCADE,
--     CONSTRAINT fk_tm_tech FOREIGN KEY (technician_id) REFERENCES technicians(id) ON DELETE CASCADE
-- ) ENGINE=InnoDB;
