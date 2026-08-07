ALTER TABLE tran_whatsapp_pi_messages
  ADD COLUMN IF NOT EXISTS media_download_status varchar(50) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS media_downloaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_download_error text,
  ADD COLUMN IF NOT EXISTS media_file_size bigint,
  ADD COLUMN IF NOT EXISTS media_download_sha256 varchar(128);

CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_download_status
  ON tran_whatsapp_pi_messages (media_download_status);
