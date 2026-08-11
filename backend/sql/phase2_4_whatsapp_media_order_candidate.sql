ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS media_order_parse_status varchar(50) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS media_order_candidate jsonb,
  ADD COLUMN IF NOT EXISTS media_order_parsed_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_order_parse_error text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_order_parse_status
  ON tran_whatsapp_pi_messages (media_order_parse_status);
