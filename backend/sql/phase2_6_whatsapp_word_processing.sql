ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS media_word_status varchar(50) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS media_word_candidate jsonb,
  ADD COLUMN IF NOT EXISTS media_word_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_word_error text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_word_status
  ON tran_whatsapp_pi_messages (media_word_status);
