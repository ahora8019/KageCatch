ALTER TABLE manual_review_items
  ADD COLUMN spawn_context_json TEXT;

CREATE INDEX IF NOT EXISTS idx_manual_review_spawn_context
  ON manual_review_items (user_id, review_id, status);