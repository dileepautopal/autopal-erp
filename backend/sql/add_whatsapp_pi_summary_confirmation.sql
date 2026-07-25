ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS pi_summary_status varchar(40) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS pi_summary_message text,
  ADD COLUMN IF NOT EXISTS pi_summary_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS pi_summary_meta_message_id varchar(160),
  ADD COLUMN IF NOT EXISTS pi_summary_error text,
  ADD COLUMN IF NOT EXISTS customer_confirmation_status varchar(40),
  ADD COLUMN IF NOT EXISTS customer_confirmation_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_confirmation_message_id varchar(160),
  ADD COLUMN IF NOT EXISTS customer_change_request text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_draft_pi_no
ON tran_whatsapp_pi_messages (draft_pi_no)
WHERE draft_pi_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_pi_summary
ON tran_whatsapp_pi_messages (message_id, draft_pi_no, pi_summary_status);
