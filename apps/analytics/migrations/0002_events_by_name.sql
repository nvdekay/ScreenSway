-- Breakdown queries filter on one source and event over a range of days. With the day first
-- (events_day) they scan every event in the range; this index reads only the matching rows.
CREATE INDEX IF NOT EXISTS events_source_name_day ON events (source, name, day);
