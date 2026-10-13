-- One row per event. `actor` is a random install ID for the app and a
-- daily-rotating salted hash for the landing page; no IP address is stored.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  actor TEXT NOT NULL,
  version TEXT,
  os TEXT,
  country TEXT,
  locale TEXT,
  props TEXT
);
CREATE INDEX events_day ON events (day, source, name);
CREATE INDEX events_actor ON events (source, actor, day);
