/**
 * Schema for the Kestrel API.
 *
 * The `annealing_points` table is the load-bearing piece of the original design: the
 * report describes each tested point being "modeled as a separate entity in our
 * database", with a cron function evaluating them one by one. Persisting candidates as
 * rows rather than holding them in a loop is what let multiple optimization requests
 * interleave under a throttled upstream, and it survives a process restart.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wind_cache (
  key           TEXT PRIMARY KEY,
  latitude      REAL NOT NULL,
  longitude     REAL NOT NULL,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  payload       TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wind_cache_fetched_at ON wind_cache (fetched_at);

CREATE TABLE IF NOT EXISTS area_requests (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','running','complete','failed')),
  min_lat        REAL NOT NULL,
  max_lat        REAL NOT NULL,
  min_lon        REAL NOT NULL,
  max_lon        REAL NOT NULL,
  turbine_id     TEXT NOT NULL,
  hub_height_m   REAL NOT NULL,
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  iterations     INTEGER NOT NULL,
  evaluated      INTEGER NOT NULL DEFAULT 0,
  seed           INTEGER NOT NULL,
  temperature    REAL NOT NULL,
  current_lat    REAL,
  current_lon    REAL,
  current_score  REAL,
  best_lat       REAL,
  best_lon       REAL,
  best_score     REAL,
  best_power_kw  REAL,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_area_requests_session
  ON area_requests (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_area_requests_status ON area_requests (status);

CREATE TABLE IF NOT EXISTS annealing_points (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   TEXT NOT NULL REFERENCES area_requests (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  latitude     REAL NOT NULL,
  longitude    REAL NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','evaluated','failed')),
  score        REAL,
  power_kw     REAL,
  temperature  REAL NOT NULL,
  accepted     INTEGER,
  is_best      INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  evaluated_at INTEGER,
  UNIQUE (request_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_annealing_points_pending
  ON annealing_points (status, id);
CREATE INDEX IF NOT EXISTS idx_annealing_points_request
  ON annealing_points (request_id, seq);
`
