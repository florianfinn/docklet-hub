CREATE TABLE notification_delivery (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  ticket_id text REFERENCES notification_ticket(id) ON DELETE RESTRICT,
  phase text NOT NULL CHECK (phase IN ('initial', 'recovery', 'test')),
  channel text NOT NULL CHECK (channel IN ('discord', 'smtp', 'gotify', 'webhook')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('queued', 'sending', 'retrying', 'delivered', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  finished_at timestamptz,
  failure text CHECK (failure IN ('transient', 'timeout', 'authentication', 'validation', 'destination-rejected', 'configuration-missing')),
  include_logs boolean NOT NULL,
  private_snapshot jsonb NOT NULL CHECK (jsonb_typeof(private_snapshot) = 'object'),
  claim_token text,
  lease_deadline timestamptz,
  cancellation_reason text CHECK (cancellation_reason IN ('target-removed', 'rule-changed', 'binding-changed', 'logs-revoked', 'channel-unconfigured')),
  UNIQUE (ticket_id, phase, channel),
  CHECK ((phase = 'test') = (ticket_id IS NULL)),
  CHECK (phase <> 'test' OR include_logs = false),
  CHECK (updated_at >= created_at),
  CHECK ((state IN ('delivered', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK (finished_at IS NULL OR finished_at BETWEEN created_at AND updated_at),
  CHECK ((state IN ('queued', 'retrying')) = (next_attempt_at IS NOT NULL)),
  CHECK (state <> 'retrying' OR next_attempt_at > updated_at),
  CHECK ((state = 'sending') = (claim_token IS NOT NULL AND lease_deadline IS NOT NULL)),
  CHECK (state = 'sending' OR (claim_token IS NULL AND lease_deadline IS NULL)),
  CHECK (claim_token IS NULL OR length(claim_token) = 36),
  CHECK (lease_deadline IS NULL OR lease_deadline > updated_at),
  CHECK (state <> 'queued' OR (attempts = 0 AND failure IS NULL)),
  CHECK (state <> 'retrying' OR (attempts BETWEEN 1 AND 3 AND failure IS NOT NULL AND failure IN ('transient', 'timeout'))),
  CHECK (state NOT IN ('sending', 'delivered') OR attempts >= 1),
  CHECK (state <> 'delivered' OR failure IS NULL),
  CHECK (state <> 'failed' OR failure IS NOT NULL),
  CHECK (state <> 'failed' OR failure NOT IN ('transient', 'timeout') OR attempts = 4),
  CHECK (state = 'cancelled' OR cancellation_reason IS NULL)
);
CREATE INDEX notification_delivery_due ON notification_delivery (next_attempt_at, id) WHERE state IN ('queued', 'retrying');
CREATE INDEX notification_delivery_lease ON notification_delivery (lease_deadline, id) WHERE state = 'sending';
CREATE INDEX notification_delivery_page ON notification_delivery (created_at DESC, id DESC);
CREATE INDEX notification_delivery_ticket ON notification_delivery (ticket_id, state);
CREATE INDEX notification_delivery_retention ON notification_delivery (finished_at, id) WHERE state IN ('delivered', 'failed', 'cancelled');
CREATE TABLE notification_delivery_history (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES notification_delivery(id) ON DELETE CASCADE,
  ticket_id text,
  generation bigint NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('delivered', 'failed', 'cancelled')),
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 4),
  failure text CHECK (failure IN ('transient', 'timeout', 'authentication', 'validation', 'destination-rejected', 'configuration-missing')),
  finished_at timestamptz NOT NULL,
  UNIQUE (delivery_id, generation)
);
CREATE INDEX notification_delivery_history_ticket ON notification_delivery_history (ticket_id, sequence DESC);
