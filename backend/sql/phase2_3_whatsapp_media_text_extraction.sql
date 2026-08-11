ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS media_extraction_status varchar(50) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS media_extracted_text text,
  ADD COLUMN IF NOT EXISTS media_extracted_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_extraction_error text,
  ADD COLUMN IF NOT EXISTS media_extraction_method varchar(50);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_extraction_status
  ON tran_whatsapp_pi_messages (media_extraction_status);
