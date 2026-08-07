ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS media_mime_type varchar(255),
  ADD COLUMN IF NOT EXISTS media_sha256 varchar(255),
  ADD COLUMN IF NOT EXISTS media_voice boolean,
  ADD COLUMN IF NOT EXISTS media_animated boolean,
  ADD COLUMN IF NOT EXISTS media_capture_status varchar(50),
  ADD COLUMN IF NOT EXISTS media_capture_error text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_message_id
  ON tran_whatsapp_pi_messages (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_id
  ON tran_whatsapp_pi_messages (media_id)
  WHERE media_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_message_type
  ON tran_whatsapp_pi_messages (message_type);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_capture_status
  ON tran_whatsapp_pi_messages (media_capture_status);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_received_at
  ON tran_whatsapp_pi_messages (received_at DESC, id DESC);
