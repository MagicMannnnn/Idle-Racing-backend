CREATE TABLE IF NOT EXISTS races (
  race_id TEXT PRIMARY KEY,
  track TEXT NOT NULL,
  laps INT NOT NULL,
  ai_count INT NOT NULL,
  host_user_id TEXT NOT NULL,
  started BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS race_users (
  race_id TEXT NOT NULL REFERENCES races(race_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (race_id, user_id)
);

CREATE TABLE IF NOT EXISTS race_user_drivers (
  race_id TEXT NOT NULL REFERENCES races(race_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  drivers JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (race_id, user_id),
  FOREIGN KEY (race_id, user_id) REFERENCES race_users(race_id, user_id) ON DELETE CASCADE
);
