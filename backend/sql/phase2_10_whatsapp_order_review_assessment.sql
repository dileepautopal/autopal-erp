ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS review_status varchar(50) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS review_decision jsonb,
  ADD COLUMN IF NOT EXISTS review_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_error text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_review_status
  ON tran_whatsapp_pi_messages (review_status);
