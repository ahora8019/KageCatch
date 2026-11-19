-- Preserve spawn metadata used by manual-review items.
-- This migration was applied to the connected KageCatch D1 database but was missing from source control.
ALTER TABLE manual_review_items ADD COLUMN spawn_context_json TEXT;
