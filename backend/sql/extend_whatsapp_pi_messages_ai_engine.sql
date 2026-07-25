BEGIN;

CREATE TABLE IF NOT EXISTS tran_whatsapp_pi_messages (
  id bigserial PRIMARY KEY,
  message_id varchar(160) UNIQUE,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sender_name varchar(160),
  sender_phone varchar(50),
  message_type varchar(40),
  media_id varchar(160),
  media_type varchar(120),
  media_path text,
  file_name text,
  caption text,
  message_text text NOT NULL DEFAULT '',
  raw_text text NOT NULL DEFAULT '',
  raw_payload jsonb,
  source_type varchar(40),
  import_status varchar(40) NOT NULL DEFAULT 'received',
  import_result jsonb,
  ocr_text text,
  processing_text text,
  parsed_json jsonb,
  parse_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
  parse_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  parse_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  parsed_payload jsonb,
  customer_id bigint,
  product_count integer NOT NULL DEFAULT 0,
  confidence_score numeric(5, 2) NOT NULL DEFAULT 0,
  draft_pi_no varchar(40),
  final_pi_no varchar(40),
  processing_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
  reply_status varchar(40) NOT NULL DEFAULT 'NOT_SENT',
  error_details jsonb,
  pi_created boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS media_id varchar(160),
  ADD COLUMN IF NOT EXISTS media_type varchar(120),
  ADD COLUMN IF NOT EXISTS media_path text,
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS caption text,
  ADD COLUMN IF NOT EXISTS raw_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS raw_payload jsonb,
  ADD COLUMN IF NOT EXISTS source_type varchar(40),
  ADD COLUMN IF NOT EXISTS ocr_text text,
  ADD COLUMN IF NOT EXISTS processing_text text,
  ADD COLUMN IF NOT EXISTS parsed_json jsonb,
  ADD COLUMN IF NOT EXISTS parse_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN IF NOT EXISTS parse_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parse_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parsed_payload jsonb,
  ADD COLUMN IF NOT EXISTS customer_id bigint,
  ADD COLUMN IF NOT EXISTS product_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence_score numeric(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS draft_pi_no varchar(40),
  ADD COLUMN IF NOT EXISTS final_pi_no varchar(40),
  ADD COLUMN IF NOT EXISTS processing_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN IF NOT EXISTS reply_status varchar(40) NOT NULL DEFAULT 'NOT_SENT',
  ADD COLUMN IF NOT EXISTS error_details jsonb,
  ADD COLUMN IF NOT EXISTS pi_created boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE tran_whatsapp_pi_messages
SET raw_text = message_text
WHERE raw_text = ''
  AND message_text <> '';

UPDATE tran_whatsapp_pi_messages
SET source_type = message_type
WHERE (source_type IS NULL OR source_type = '')
  AND message_type IS NOT NULL
  AND message_type <> '';

UPDATE tran_whatsapp_pi_messages
SET parse_status =
  CASE
    WHEN LOWER(import_status) = 'imported' THEN 'PI_CREATED'
    WHEN LOWER(import_status) = 'duplicate' THEN 'DUPLICATE'
    WHEN LOWER(import_status) = 'error' THEN 'PI_FAILED'
    ELSE 'RECEIVED'
  END
WHERE parse_status IS NULL
   OR parse_status = ''
   OR parse_status = 'RECEIVED';

UPDATE tran_whatsapp_pi_messages
SET processing_status = parse_status
WHERE processing_status = 'RECEIVED'
  AND parse_status IS NOT NULL
  AND parse_status <> ''
  AND parse_status <> 'RECEIVED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_message_id
ON tran_whatsapp_pi_messages (message_id)
WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_received_at
ON tran_whatsapp_pi_messages (received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS tran_whatsapp_pi_message_events (
  id bigserial PRIMARY KEY,
  message_id varchar(160) NOT NULL,
  processing_status varchar(40),
  parse_status varchar(40),
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_message_events_message_id
ON tran_whatsapp_pi_message_events (message_id, created_at DESC);

COMMIT;
