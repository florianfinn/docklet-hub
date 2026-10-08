import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Role } from "../../platform/session/session-user";
import { createOperations, lifecycleOperations } from "./lifecycle-operations";

const LifecycleSession = createContext<{
  role: Role; operations: ReturnType<typeof createOperations>; signal: AbortSignal;
} | null>(null);
export function LifecycleProvider({ role, children }: { role: Role; children: ReactNode }) {
  const [operations] = useState(createOperations);
  const [session] = useState(() => new AbortController());
  const disposal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(disposal.current);
    return () => { disposal.current = setTimeout(() => session.abort(), 0); };
  }, [session]);
  return <LifecycleSession.Provider value={{ role, operations, signal: session.signal }}>
    {children}
  </LifecycleSession.Provider>;
}
export function useLifecycleSession() {
  const session = useContext(LifecycleSession);
  const client = useQueryClient();
  return session ?? { role: "user" as const, operations: lifecycleOperations(client), signal: undefined };
}
