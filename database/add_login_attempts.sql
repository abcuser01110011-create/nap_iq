-- Optional: the app creates this table automatically on first use.
CREATE TABLE IF NOT EXISTS login_attempts (
    key        VARCHAR(255) PRIMARY KEY,
    attempts   INTEGER      NOT NULL DEFAULT 0,
    expires_at TIMESTAMP    NOT NULL
);
