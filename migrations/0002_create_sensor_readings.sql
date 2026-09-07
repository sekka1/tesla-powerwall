CREATE TABLE IF NOT EXISTS sensor_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  temperature REAL NOT NULL,
  humidity REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS sensor_readings_recent_idx
  ON sensor_readings (observed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS sensor_readings_device_series_idx
  ON sensor_readings (device_id, observed_at ASC, id ASC);
