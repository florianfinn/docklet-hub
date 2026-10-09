CREATE TABLE notification_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision <= 9007199254740991),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object')
);
CREATE TABLE notification_scope (
  target_key text PRIMARY KEY,
  host_id text NOT NULL REFERENCES docker_host(id) ON DELETE CASCADE,
  target jsonb NOT NULL,
  configuration jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE notification_ticket (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  target_key text NOT NULL,
  episode_key text NOT NULL CHECK (length(episode_key) BETWEEN 1 AND 200),
  event text NOT NULL CHECK (event IN ('self-healing-exhausted', 'connection-lost', 'update-failed', 'agent-update-available', 'container-update-available')),
  host_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('host', 'stack', 'container')),
  state text NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved')),
  opened_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  observed_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  UNIQUE (source, target_key, episode_key),
  CHECK (observed_at >= opened_at),
  CHECK (acknowledged_at IS NULL OR acknowledged_at >= opened_at),
  CHECK (resolved_at IS NULL OR resolved_at >= COALESCE(acknowledged_at, opened_at)),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (state <> 'open' OR acknowledged_at IS NULL),
  CHECK (state <> 'acknowledged' OR acknowledged_at IS NOT NULL)
);
CREATE INDEX notification_ticket_page ON notification_ticket (opened_at DESC, id DESC);
CREATE INDEX notification_ticket_retention ON notification_ticket (resolved_at) WHERE state = 'resolved';
CREATE TABLE notification_delivery_intention (
  ticket_id text NOT NULL REFERENCES notification_ticket(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('initial', 'recovery')),
  channel text NOT NULL CHECK (channel IN ('discord', 'smtp', 'gotify', 'webhook')),
  configuration_revision bigint NOT NULL,
  snapshot jsonb NOT NULL,
  admitted_at timestamptz,
  PRIMARY KEY (ticket_id, phase, channel)
);
CREATE INDEX notification_intention_pending ON notification_delivery_intention (ticket_id) WHERE admitted_at IS NULL;
