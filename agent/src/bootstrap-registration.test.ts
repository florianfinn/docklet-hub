import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REGISTRATION_DEADLINE_MS,
  REGISTRATION_HARD_LIMIT_MS,
  nextRegistrationStep,
  registerBootstrapOnce,
  startBootstrapRegistration,
  dateFromResponse,
  type BootstrapRegistrationConfig,
  type Clock
} from "./bootstrap-registration.js";

function tempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-"));
  return path.join(dir, "bootstrap-registered.json");
}

function config(overrides: Partial<BootstrapRegistrationConfig> = {}): BootstrapRegistrationConfig {
  return {
    registrationUrl: "http://10.253.0.254:3000/api/hosts/bootstrap",
    registrationToken: "t".repeat(32),
    stateFile: tempStateFile(),
    listenHost: "10.253.0.1",
    listenPort: 8099,
    readOnly: false,
    agentVersion: "9.9.9",
    ...overrides
  };
}

function response(status: number, extras: { retryAfter?: string; body?: unknown } = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? extras.retryAfter ?? null : null) },
    json: async () => extras.body ?? {}
  } as unknown as Response;
}

// Clock and timers in one hand: otherwise the expiry of the deadline can only
// be checked in real time, and no test waits a quarter of an hour.
function fakeClock() {
  let time = 0;
  let open: { callback: () => void; ms: number } | null = null;
  const clock: Clock = {
    now: () => time,
    schedule: (callback, ms) => {
      open = { callback, ms };
      return {
        cancel: () => {
          open = null;
        }
      };
    }
  };
  // Works through all scheduled attempts until none is pending. The limit is
  // the actual statement of the test: without a cap this loop would never end
  // — exactly the state that R9 objects to.
  const drain = async (maxSteps = 500): Promise<number> => {
    let steps = 0;
    while (open && steps < maxSteps) {
      const next = open;
      open = null;
      time += next.ms;
      next.callback();
      // The callback starts an async function; its continuation sits in the
      // microtask queue and must have run before the next step.
      await new Promise((r) => setImmediate(r));
      steps += 1;
    }
    return steps;
  };
  return { clock, drain, time: () => time, pending: () => open !== null };
}

test("nextRegistrationStep doubles the wait and caps it at 180 s", () => {
  const waits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(
    (attempts) => (nextRegistrationStep({ attempts, elapsedMs: 0 }) as { waitMs: number }).waitMs
  );
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 180_000, 180_000]);
});

// The reason for the 180 s cap is not in the agent but on the other side: the
// registration endpoint of the main API allows TWELVE attempts per 15 minutes
// and source IP. Whoever changes the deadline or the cap has to pass by here —
// otherwise the agent burns through the budget again within a few minutes and
// runs into a rate limit for the rest of the deadline.
test("the cadence stays within the main API's budget (12 attempts per 15 min)", () => {
  const MAIN_API_BUDGET = 12;
  let time = 1_000;
  let attempts = 1;
  for (;;) {
    const step = nextRegistrationStep({ attempts, elapsedMs: time });
    if (!step.proceed) break;
    time += step.waitMs;
    attempts += 1;
  }
  assert.equal(attempts, MAIN_API_BUDGET);
  assert.ok(time <= REGISTRATION_DEADLINE_MS, `${time} ms liegen hinter der Frist`);
});

test("nextRegistrationStep gives up immediately when the other side rejects", () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.deepEqual(
      nextRegistrationStep({ attempts: 1, elapsedMs: 0, status }),
      { proceed: false, reason: "rejected" },
      `Status ${status} sollte endgueltig sein`
    );
  }
});

test("nextRegistrationStep retries on 5xx and on the three 4xx that mean 'later'", () => {
  for (const status of [408, 425, 429, 500, 502, 503]) {
    assert.equal(
      nextRegistrationStep({ attempts: 1, elapsedMs: 0, status }).proceed,
      true,
      `Status ${status} sollte wiederholbar sein`
    );
  }
  // No status means: no answer at all (DNS, timeout, tunnel is not up).
  assert.equal(nextRegistrationStep({ attempts: 1, elapsedMs: 0 }).proceed, true);
});

test("nextRegistrationStep schedules no attempt that would lie past the deadline", () => {
  // At the tenth attempt the wait is 180 s. If the next attempt thereby lies
  // past the deadline, it is no longer scheduled.
  assert.deepEqual(
    nextRegistrationStep({ attempts: 10, elapsedMs: REGISTRATION_DEADLINE_MS - 179_000 }),
    { proceed: false, reason: "deadline" }
  );
  assert.equal(nextRegistrationStep({ attempts: 10, elapsedMs: REGISTRATION_DEADLINE_MS - 181_000 }).proceed, true);
});

test("registration gives up after the deadline instead of trying forever", async () => {
  const { clock, drain, time } = fakeClock();
  let attempts = 0;
  const ends: string[] = [];
  const registration = startBootstrapRegistration(config(), {
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    },
    log: () => {},
    clock,
    onEnd: (state, reason) => ends.push(reason)
  });

  await drain();

  assert.deepEqual(ends, ["deadline"]);
  assert.equal(registration.state().phase, "given-up");
  assert.equal(registration.state().attempts, attempts);
  // Enough attempts to bridge a short outage, but no more than the other side
  // accepts in that time.
  assert.equal(attempts, 12);
  // … and the deadline kept: the last attempt does not lie past it.
  assert.ok(time() <= REGISTRATION_DEADLINE_MS, `${time()} ms verbraucht`);
});

test("a rejection does not send the one-time token out another thirty times", async () => {
  const { clock, drain, pending: pending } = fakeClock();
  let attempts = 0;
  const ends: string[] = [];
  const registration = startBootstrapRegistration(config(), {
    // 404: the most common case of a misconfigured URL.
    fetchImpl: async () => {
      attempts += 1;
      return response(404);
    },
    log: () => {},
    clock,
    onEnd: (state, reason) => ends.push(reason)
  });

  await drain();

  assert.equal(attempts, 1);
  assert.equal(pending(), false);
  assert.deepEqual(ends, ["rejected"]);
  assert.deepEqual(registration.state(), { phase: "given-up", attempts: 1 });
});

test("a 503 is retried and the success afterwards writes the marker", async () => {
  const { clock, drain } = fakeClock();
  const cfg = config();
  let attempts = 0;
  const ends: string[] = [];
  const registration = startBootstrapRegistration(cfg, {
    fetchImpl: async () => {
      attempts += 1;
      return response(attempts < 3 ? 503 : 200);
    },
    log: () => {},
    clock,
    onEnd: (state, reason) => ends.push(reason)
  });

  await drain();

  assert.equal(attempts, 3);
  assert.deepEqual(ends, ["registered"]);
  assert.deepEqual(registration.state(), { phase: "registered", attempts: 3 });
  const marker = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")) as { registrationUrl: string };
  assert.equal(marker.registrationUrl, cfg.registrationUrl);
});

test("an error while logging the end does not take the registration down with it", async () => {
  const { clock, drain } = fakeClock();
  const messages: string[] = [];
  const registration = startBootstrapRegistration(config(), {
    fetchImpl: async () => response(403),
    log: (message) => messages.push(message),
    clock,
    // That is how the audit log behaves when the /state volume is full: it throws.
    onEnd: () => {
      throw new Error("ENOSPC");
    }
  });

  await drain();

  assert.equal(registration.state().phase, "given-up");
  assert.ok(messages.some((m) => m.includes("could not be recorded")));
});

test("without configuration nothing is attempted and /health says 'off'", async () => {
  const { clock, drain } = fakeClock();
  let attempts = 0;
  const registration = startBootstrapRegistration(config({ registrationUrl: null, registrationToken: null }), {
    fetchImpl: async () => {
      attempts += 1;
      return response(200);
    },
    log: () => {},
    clock
  });

  assert.equal(await drain(), 0);
  assert.equal(attempts, 0);
  assert.deepEqual(registration.state(), { phase: "off", attempts: 0 });
});

test("an existing marker reports 'registered' without sending the token again", async () => {
  const cfg = config();
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ registrationUrl: cfg.registrationUrl }), "utf8");
  const { clock, drain } = fakeClock();
  let attempts = 0;
  const registration = startBootstrapRegistration(cfg, {
    fetchImpl: async () => {
      attempts += 1;
      return response(200);
    },
    log: () => {},
    clock
  });

  assert.equal(await drain(), 0);
  assert.equal(attempts, 0);
  assert.deepEqual(registration.state(), { phase: "registered", attempts: 0 });
});

test("stop() cancels a scheduled attempt", async () => {
  const { clock, drain, pending: pending } = fakeClock();
  let attempts = 0;
  const registration = startBootstrapRegistration(config(), {
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    },
    log: () => {},
    clock
  });

  await drain(2);
  registration.stop();
  assert.equal(pending(), false);
  assert.equal(await drain(), 0);
  assert.equal(attempts, 2);
});

test("registerBootstrapOnce reports the status of the rejection in the error", async () => {
  await assert.rejects(
    () => registerBootstrapOnce(config(), async () => response(409)),
    (error: unknown) => {
      assert.equal((error as { name: string }).name, "RegistrationError");
      assert.equal((error as { status: number }).status, 409);
      return true;
    }
  );
});

test("registerBootstrapOnce sends version, address and readOnly along", async () => {
  const cfg = config({ readOnly: true });
  let seen: { url: string; init: RequestInit } | null = null;
  const result = await registerBootstrapOnce(cfg, async (url, init) => {
    seen = { url: String(url), init: init ?? {} };
    return response(200);
  });

  assert.equal(result, "registered");
  const request = seen as unknown as { url: string; init: RequestInit };
  assert.equal(request.url, cfg.registrationUrl);
  assert.equal(
    (request.init.headers as Record<string, string>)["x-docker-host-registration"],
    cfg.registrationToken
  );
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    agentVersion: "9.9.9",
    listenHost: "10.253.0.1",
    listenPort: 8099,
    readOnly: true
  });
});

// --- Dates named by the other side (429 with Retry-After) ------------------

test("dateFromResponse reads the header as seconds and as an HTTP date", async () => {
  assert.equal(await dateFromResponse(response(429, { retryAfter: "90" })), 90_000);
  const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
  const fromDate = await dateFromResponse(response(429, { retryAfter: inTwoMinutes }));
  assert.ok(fromDate !== undefined && Math.abs(fromDate - 120_000) < 2_000, `${fromDate} ms`);
});

test("dateFromResponse otherwise reads retryAfterSeconds from the body", async () => {
  // That is how the main API answers: 429 with { error, retryAfterSeconds }.
  assert.equal(await dateFromResponse(response(429, { body: { error: "Too many attempts", retryAfterSeconds: 640 } })), 640_000);
});

test("dateFromResponse discards nonsensical values instead of inventing a wait", async () => {
  for (const retryAfter of ["", "bald", "-5", "999999"]) {
    assert.equal(await dateFromResponse(response(429, { retryAfter })), undefined, `Wert ${retryAfter}`);
  }
  assert.equal(await dateFromResponse(response(429, { body: { retryAfterSeconds: "viel" } })), undefined);
});

test("a named date beats the own backoff", () => {
  const step = nextRegistrationStep({ attempts: 1, elapsedMs: 0, status: 429, dueMs: 640_000 });
  assert.deepEqual(step, { proceed: true, waitMs: 640_000, due: true });
  // Without a date the backoff stays — even with 429.
  assert.deepEqual(nextRegistrationStep({ attempts: 1, elapsedMs: 0, status: 429 }), {
    proceed: true,
    waitMs: 1_000,
    due: false
  });
});

test("an honoured date does not count against the deadline", () => {
  // Without a date it would end here: the own waiting time is almost used up.
  assert.deepEqual(nextRegistrationStep({ attempts: 9, elapsedMs: REGISTRATION_DEADLINE_MS - 1_000 }), {
    proceed: false,
    reason: "deadline"
  });
  // With a date the requested wait does not count as the own.
  assert.deepEqual(
    nextRegistrationStep({
      attempts: 9,
      elapsedMs: REGISTRATION_DEADLINE_MS - 1_000,
      totalMs: REGISTRATION_DEADLINE_MS - 1_000,
      status: 429,
      dueMs: 600_000
    }),
    { proceed: true, waitMs: 600_000, due: true }
  );
});

test("the hard limit ranks above every date", () => {
  assert.deepEqual(
    nextRegistrationStep({
      attempts: 9,
      elapsedMs: 60_000,
      totalMs: REGISTRATION_HARD_LIMIT_MS - 60_000,
      status: 429,
      dueMs: 600_000
    }),
    { proceed: false, reason: "limit" }
  );
});

test("an endpoint that only ever names dates ends at the hard limit", async () => {
  const { clock, drain, time } = fakeClock();
  let attempts = 0;
  const ends: string[] = [];
  const registration = startBootstrapRegistration(config(), {
    // Always 429 with "again in ten minutes" — exactly the answer with which
    // the main API's rate limit could otherwise string an agent along forever.
    fetchImpl: async () => {
      attempts += 1;
      return response(429, { body: { retryAfterSeconds: 600 } });
    },
    log: () => {},
    clock,
    onEnd: (state, reason) => ends.push(reason)
  });

  await drain();

  assert.deepEqual(ends, ["limit"]);
  assert.equal(registration.state().phase, "given-up");
  // The deadline alone would have aborted here after 15 minutes; the dates do
  // not count against it, the hard limit does.
  assert.ok(time() > REGISTRATION_DEADLINE_MS, `${time()} ms`);
  assert.ok(time() <= REGISTRATION_HARD_LIMIT_MS, `${time()} ms`);
  assert.equal(attempts, 6);
});

test("after a rate-limit date things continue normally", async () => {
  const { clock, drain } = fakeClock();
  const waitTimes: number[] = [];
  let attempts = 0;
  const registration = startBootstrapRegistration(config(), {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return response(429, { body: { retryAfterSeconds: 300 } });
      if (attempts === 2) return response(503);
      return response(200);
    },
    log: (message) => {
      const match = /next attempt in (\d+) s/.exec(message);
      if (match) waitTimes.push(Number(match[1]));
    },
    clock
  });

  await drain();

  assert.deepEqual(waitTimes, [300, 2]);
  assert.deepEqual(registration.state(), { phase: "registered", attempts: 3 });
});
