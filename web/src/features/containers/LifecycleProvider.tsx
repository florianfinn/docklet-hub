import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Role } from "../../platform/session/session-user";
import { createOperations, lifecycleOperations } from "./lifecycle-operations";

const LifecycleSession = createContext<{
  role: Role; operations: ReturnType<typeof createOperations>; signal: AbortSignal;
} | null>(null);
const LifecycleClock = createContext<number | null>(null);
export function LifecycleProvider({ role, children }: { role: Role; children: ReactNode }) {
  const [operations] = useState(createOperations);
  const [session] = useState(() => new AbortController());
  const [now, setNow] = useState(Date.now);
  const disposal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(disposal.current);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => { clearInterval(timer); disposal.current = setTimeout(() => session.abort(), 0); };
  }, [session]);
  return <LifecycleSession.Provider value={{ role, operations, signal: session.signal }}>
    <LifecycleClock.Provider value={now}>{children}</LifecycleClock.Provider>
  </LifecycleSession.Provider>;
}
export function useLifecycleSession() {
  const session = useContext(LifecycleSession);
  const client = useQueryClient();
  return session ?? { role: "user" as const, operations: lifecycleOperations(client), signal: undefined };
}
export function useLifecycleNow(): number {
  const [initial] = useState(Date.now);
  return useContext(LifecycleClock) ?? initial;
}
