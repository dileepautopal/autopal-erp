ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS media_excel_status varchar(50) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS media_excel_candidate jsonb,
  ADD COLUMN IF NOT EXISTS media_excel_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_excel_error text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_excel_status
  ON tran_whatsapp_pi_messages (media_excel_status);
