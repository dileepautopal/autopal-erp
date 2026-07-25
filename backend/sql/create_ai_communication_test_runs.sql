CREATE TABLE IF NOT EXISTS tran_ai_communication_test_runs (
  test_run_id bigserial PRIMARY KEY,
  test_type varchar(80) NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  duration_ms integer,
  requested_by varchar(80),
  input_summary text,
  result_json jsonb,
  success boolean NOT NULL DEFAULT false,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  dry_run boolean NOT NULL DEFAULT true,
  database_changed boolean NOT NULL DEFAULT false,
  whatsapp_message_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tran_ai_communication_test_runs_created_at
ON tran_ai_communication_test_runs (created_at DESC, test_run_id DESC);
