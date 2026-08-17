ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS media_mixed_status varchar(50) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS media_mixed_context jsonb,
  ADD COLUMN IF NOT EXISTS media_mixed_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_mixed_error text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_mixed_sender_time
  ON tran_whatsapp_pi_messages (sender_phone, received_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_mixed_status
  ON tran_whatsapp_pi_messages (media_mixed_status);
