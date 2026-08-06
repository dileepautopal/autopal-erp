CREATE TABLE IF NOT EXISTS tran_whatsapp_send_log (
  send_log_id bigserial PRIMARY KEY,
  source_message_record_id bigint,
  source_whatsapp_message_id varchar(160),
  pi_number varchar(40),
  customer_id bigint,
  sender_phone varchar(50),
  destination_phone varchar(50),
  message_purpose varchar(80) NOT NULL,
  message_type varchar(40) NOT NULL DEFAULT 'text',
  message_body text,
  request_payload jsonb,
  request_url text,
  graph_api_version varchar(20),
  phone_number_id varchar(80),
  attempt_number integer NOT NULL DEFAULT 1,
  attempt_status varchar(40) NOT NULL DEFAULT 'PENDING',
  failure_category varchar(80),
  retryable boolean NOT NULL DEFAULT false,
  http_status integer,
  http_status_text text,
  meta_message_id varchar(160),
  meta_response jsonb,
  meta_error_type varchar(120),
  meta_error_code varchar(80),
  meta_error_subcode varchar(80),
  meta_error_message text,
  meta_fbtrace_id varchar(160),
  network_error_code varchar(120),
  network_error_message text,
  request_started_at timestamptz,
  request_completed_at timestamptz,
  duration_ms integer,
  next_retry_at timestamptz,
  retry_batch_id uuid,
  parent_send_log_id bigint REFERENCES tran_whatsapp_send_log(send_log_id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE tran_whatsapp_send_log
  ADD COLUMN IF NOT EXISTS source_message_record_id bigint,
  ADD COLUMN IF NOT EXISTS source_whatsapp_message_id varchar(160),
  ADD COLUMN IF NOT EXISTS pi_number varchar(40),
  ADD COLUMN IF NOT EXISTS customer_id bigint,
  ADD COLUMN IF NOT EXISTS sender_phone varchar(50),
  ADD COLUMN IF NOT EXISTS destination_phone varchar(50),
  ADD COLUMN IF NOT EXISTS message_purpose varchar(80),
  ADD COLUMN IF NOT EXISTS message_type varchar(40) NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS message_body text,
  ADD COLUMN IF NOT EXISTS request_payload jsonb,
  ADD COLUMN IF NOT EXISTS request_url text,
  ADD COLUMN IF NOT EXISTS graph_api_version varchar(20),
  ADD COLUMN IF NOT EXISTS phone_number_id varchar(80),
  ADD COLUMN IF NOT EXISTS attempt_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS attempt_status varchar(40) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS failure_category varchar(80),
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS http_status integer,
  ADD COLUMN IF NOT EXISTS http_status_text text,
  ADD COLUMN IF NOT EXISTS meta_message_id varchar(160),
  ADD COLUMN IF NOT EXISTS meta_response jsonb,
  ADD COLUMN IF NOT EXISTS meta_error_type varchar(120),
  ADD COLUMN IF NOT EXISTS meta_error_code varchar(80),
  ADD COLUMN IF NOT EXISTS meta_error_subcode varchar(80),
  ADD COLUMN IF NOT EXISTS meta_error_message text,
  ADD COLUMN IF NOT EXISTS meta_fbtrace_id varchar(160),
  ADD COLUMN IF NOT EXISTS network_error_code varchar(120),
  ADD COLUMN IF NOT EXISTS network_error_message text,
  ADD COLUMN IF NOT EXISTS request_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS request_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_batch_id uuid,
  ADD COLUMN IF NOT EXISTS parent_send_log_id bigint,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS acknowledgement_status varchar(40) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS acknowledgement_message text,
  ADD COLUMN IF NOT EXISTS acknowledgement_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledgement_whatsapp_message_id varchar(160),
  ADD COLUMN IF NOT EXISTS acknowledgement_error text,
  ADD COLUMN IF NOT EXISTS acknowledgement_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pi_summary_status varchar(40) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS pi_summary_message text,
  ADD COLUMN IF NOT EXISTS pi_summary_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS pi_summary_meta_message_id varchar(160),
  ADD COLUMN IF NOT EXISTS pi_summary_error text;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_source_message
ON tran_whatsapp_send_log (source_whatsapp_message_id);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_pi_number
ON tran_whatsapp_send_log (pi_number);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_destination
ON tran_whatsapp_send_log (destination_phone);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_purpose
ON tran_whatsapp_send_log (message_purpose);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_status_retry
ON tran_whatsapp_send_log (attempt_status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_created_at
ON tran_whatsapp_send_log (created_at DESC, send_log_id DESC);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_meta_message
ON tran_whatsapp_send_log (meta_message_id)
WHERE meta_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_unique_success
ON tran_whatsapp_send_log (
  COALESCE(source_whatsapp_message_id, ''),
  COALESCE(pi_number, ''),
  message_purpose
)
WHERE attempt_status = 'SENT';
