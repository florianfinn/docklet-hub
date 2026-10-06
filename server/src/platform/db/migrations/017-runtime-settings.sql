-- Global defaults also apply to existing installations without reopening setup.
CREATE TABLE runtime_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  apply_compose_definition boolean NOT NULL DEFAULT true,
  self_healing_config jsonb NOT NULL DEFAULT '{"enabled":true,"attempts":3,"retryDelaysSeconds":[10,60,300],"stabilityWindowSeconds":600,"maintenanceDurationSeconds":3600}'::jsonb,
  self_healing_revision integer NOT NULL DEFAULT 1 CHECK (self_healing_revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO runtime_settings (singleton) VALUES (true);

CREATE TABLE self_healing_delivery (
  host_id text PRIMARY KEY REFERENCES docker_host(id) ON DELETE CASCADE,
  applied_revision integer,
  status text NOT NULL CHECK (status IN ('synced', 'failed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
