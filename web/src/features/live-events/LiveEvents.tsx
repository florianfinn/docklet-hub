import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectLiveEvents } from "./client";

export function LiveEvents() {
  const client = useQueryClient();
  useEffect(() => connectLiveEvents(client), [client]);
  return null;
}
