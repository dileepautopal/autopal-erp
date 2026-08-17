ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS unified_order_status varchar(50) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS unified_order_input jsonb,
  ADD COLUMN IF NOT EXISTS unified_order_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS unified_order_error text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_unified_order_status
  ON tran_whatsapp_pi_messages (unified_order_status);
