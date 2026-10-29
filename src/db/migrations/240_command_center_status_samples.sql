-- 240_command_center_status_samples.sql
--
-- Persisted card status, so the console's history survives a restart and a
-- second API replica samples the same timeline.
--
-- ── Why status and not every metric ────────────────────────────────────────
--
-- The live snapshot already carries each card's numbers; what it cannot carry
-- is MEMORY. The console's sparklines live in the browser and reset on reload,
-- and an alert resolved yesterday leaves a gap in the one question an operator
-- asks next: "has this been flapping, or was it a one-off?"
--
-- One row per card per sample, status only. The numbers stay in the snapshot
-- they belong to; a second copy here would be a second place for them to go
-- stale, and a chart nobody asked for yet. 5-minute sampling, 14-day retention
-- (CC_METRIC_SAMPLE_MS / CC_METRIC_RETENTION_DAYS), which is ~3.2k rows/day.

CREATE TABLE IF NOT EXISTS command_center_status_samples (
  id         BIGSERIAL PRIMARY KEY,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  card       TEXT NOT NULL,
  status     TEXT NOT NULL
);

-- The read is "one window, every card"; the sweep is "everything older than N
-- days". Two indexes, one per query shape.
CREATE INDEX IF NOT EXISTS cc_status_samples_card_time
  ON command_center_status_samples (card, sampled_at DESC);
CREATE INDEX IF NOT EXISTS cc_status_samples_time
  ON command_center_status_samples (sampled_at);
