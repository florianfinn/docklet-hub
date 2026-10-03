import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { createQueryClient } from "../../platform/query/query-client";

// The query cache of the app (#256).
//
// ⚠️ THE CLIENT IS BUILT IN `useState` AND NOT AT MODULE LEVEL. A module value
// would outlive the tree: a test mounting the app twice would read the first
// mount's cache in the second. One client per mounted tree, built once.
//
// What happens to the cache when the session ends is decided in
// `web/src/App.tsx`, the one place that knows whether someone is signed in.
export function AppQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
