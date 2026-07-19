CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS servers (
  server_id text PRIMARY KEY,
  display_name text NOT NULL,
  hostname text NOT NULL,
  region text NOT NULL DEFAULT '未分组',
  provider text NOT NULL DEFAULT '自建',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  os text NOT NULL,
  arch text NOT NULL,
  cpu_model text NOT NULL,
  cpu_cores integer NOT NULL,
  mem_total_mb bigint NOT NULL,
  disk_total_mb bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS server_metrics_1m (
  bucket_time timestamptz NOT NULL,
  server_id text NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
  sample_count integer NOT NULL,
  cpu_avg double precision NOT NULL,
  cpu_max double precision NOT NULL,
  memory_avg double precision NOT NULL,
  memory_max double precision NOT NULL,
  load_1_avg double precision NOT NULL,
  disk_usage_last double precision NOT NULL,
  disk_read_avg double precision NOT NULL,
  disk_read_max double precision NOT NULL,
  disk_write_avg double precision NOT NULL,
  disk_write_max double precision NOT NULL,
  network_rx_avg double precision NOT NULL,
  network_rx_max double precision NOT NULL,
  network_tx_avg double precision NOT NULL,
  network_tx_max double precision NOT NULL,
  total_rx_last bigint NOT NULL,
  total_tx_last bigint NOT NULL,
  tcp_established_max integer NOT NULL,
  uptime_last bigint NOT NULL,
  PRIMARY KEY (server_id, bucket_time)
);

SELECT create_hypertable(
  'server_metrics_1m',
  by_range('bucket_time'),
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS server_metrics_1m_time_idx
  ON server_metrics_1m (server_id, bucket_time DESC);

SELECT add_retention_policy(
  'server_metrics_1m',
  INTERVAL '90 days',
  if_not_exists => TRUE
);
