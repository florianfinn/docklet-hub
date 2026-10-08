CREATE TABLE container_update_setting (
  host_id text NOT NULL REFERENCES docker_host(id) ON DELETE CASCADE,
  target_key text NOT NULL,
  start_deadline_seconds integer NOT NULL DEFAULT 120
    CHECK (start_deadline_seconds BETWEEN 10 AND 1800),
  PRIMARY KEY (host_id, target_key)
);
