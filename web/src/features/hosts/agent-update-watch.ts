import { fetchAgentUpdateStatus, type AgentUpdateLastRun } from "./api";

// The watch over one agent update after the hub started it (#7): ask the arm
// every `POLL_MS` until its last run carries the job id the start returned,
// and give up after `DEADLINE_MS`. The reasons for both numbers stand in
// `AgentUpdate.tsx`.
//
// ⚠️ A PROCESS AND NOT A READ, so it lives outside React (#271). The card
// starts it in an effect and stops it in the cleanup; the effect itself calls
// nothing on the hub (`local/no-api-call-in-effect`). It is not a query: it
// has a deadline, a first question that waits one beat (the arm has just
// started to swap), and an arm that does not answer for minutes, which is
// "still running" here and not an error. The same split as the stream store
// in `platform/streams/`: the module owns timers and cancellation, the view
// only subscribes.

export const POLL_MS = 3_000;
export const DEADLINE_MS = 10 * 60_000;

export type AgentUpdateWatch = {
  hostId: string;
  jobId: string;
  /** `Date.now()` when the start was accepted; the deadline counts from here. */
  startedAt: number;
  /** The run of THIS job has ended; called once, and the watch stops. */
  onOutcome: (last: AgentUpdateLastRun) => void;
  /** The deadline passed without an outcome; called once, and the watch stops. */
  onTimeout: () => void;
};

/** Starts the watch; the returned function stops it, and nothing is reported after that. */
export function watchAgentUpdate({ hostId, jobId, startedAt, onOutcome, onTimeout }: AgentUpdateWatch): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = () => {
    if (Date.now() - startedAt > DEADLINE_MS) {
      onTimeout();
      return;
    }
    fetchAgentUpdateStatus(hostId)
      .then((status) => {
        if (cancelled) return;
        if (!status.running && status.last?.jobId === jobId) {
          onOutcome(status.last);
          return;
        }
        timer = setTimeout(poll, POLL_MS);
      })
      .catch(() => {
        // The arm is swapping right now: no answer means "still running".
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      });
  };
  timer = setTimeout(poll, POLL_MS);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
