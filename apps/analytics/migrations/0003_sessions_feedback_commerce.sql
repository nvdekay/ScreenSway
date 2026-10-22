-- Adds columns and tables only; existing events are kept as they are (new columns are NULL).

-- `session_id`: a random ID per browser tab journey (landing → /app/, sessionStorage) or per
-- desktop launch. `visitor_id`: a stable random browser ID that exists only after the visitor
-- opted in; it is the only browser ID used for retention.
ALTER TABLE events ADD COLUMN session_id TEXT;
ALTER TABLE events ADD COLUMN visitor_id TEXT;
CREATE INDEX IF NOT EXISTS events_session ON events (session_id, ts) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_visitor ON events (visitor_id, day) WHERE visitor_id IS NOT NULL;

-- Feedback people type and send on purpose. Kept apart from events, never mixed into
-- breakdowns. Rows older than FEEDBACK_RETENTION_DAYS are deleted by the daily cron.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  rating INTEGER,
  message TEXT NOT NULL,
  email TEXT,
  version TEXT,
  os TEXT,
  browser TEXT,
  locale TEXT,
  country TEXT,
  session_id TEXT,
  -- Salted SHA-256 of the sender's address and the message, to refuse the same text sent
  -- again from the same address within a day. Not reversible to the address.
  message_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  admin_note TEXT
);
CREATE INDEX IF NOT EXISTS feedback_day ON feedback (day, id);
CREATE INDEX IF NOT EXISTS feedback_status ON feedback (status, id);
CREATE INDEX IF NOT EXISTS feedback_category ON feedback (category, id);
CREATE INDEX IF NOT EXISTS feedback_hash ON feedback (message_hash, created_at);

-- Purchases, refunds and licences, written only by a verified Merchant of Record webhook
-- (none exists yet; see docs/analytics.md). `provider_event_id` makes deliveries idempotent;
-- no email, name or raw payment ID is stored.
CREATE TABLE IF NOT EXISTS commerce_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  type TEXT NOT NULL,
  product TEXT,
  amount_minor INTEGER,
  currency TEXT,
  country TEXT,
  -- SHA-256 of the provider's transaction ID with a salt, to tie a refund to its purchase.
  transaction_hash TEXT,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS commerce_day ON commerce_events (day, type);
