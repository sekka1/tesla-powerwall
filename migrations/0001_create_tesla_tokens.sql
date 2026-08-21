-- Tesla OAuth state tracking and multi-tenant credential storage.

CREATE TABLE IF NOT EXISTS tesla_users (
  id TEXT PRIMARY KEY,
  tesla_site_id TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
