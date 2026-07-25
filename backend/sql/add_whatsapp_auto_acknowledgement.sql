ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS acknowledgement_status varchar(40) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS acknowledgement_message text,
  ADD COLUMN IF NOT EXISTS acknowledgement_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledgement_whatsapp_message_id varchar(160),
  ADD COLUMN IF NOT EXISTS acknowledgement_error text,
  ADD COLUMN IF NOT EXISTS acknowledgement_attempts integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tran_whatsapp_outgoing_messages (
  outgoing_id bigserial PRIMARY KEY,
  source_message_id bigint,
  source_whatsapp_message_id varchar(160),
  to_phone varchar(50) NOT NULL,
  message_type varchar(40) NOT NULL DEFAULT 'text',
  message_body text NOT NULL,
  purpose varchar(80) NOT NULL,
  pi_number varchar(40),
  send_status varchar(40) NOT NULL DEFAULT 'PENDING',
  meta_message_id varchar(160),
  meta_response jsonb,
  error_code varchar(80),
  error_message text,
  attempt_count integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tran_whatsapp_outgoing_auto_ack_source
ON tran_whatsapp_outgoing_messages (source_whatsapp_message_id, purpose);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_outgoing_created_at
ON tran_whatsapp_outgoing_messages (created_at DESC, outgoing_id DESC);
