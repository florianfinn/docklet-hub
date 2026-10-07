import fs from "node:fs";

// Boot identity also detects reboot when socket activation preserves a path.
export function daemonGeneration(socketPath: string): string {
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const socket = fs.statSync(socketPath, { bigint: true });
  if (!boot || !socket.isSocket()) throw new Error("Docker daemon generation unavailable");
  return `${boot}:${socket.dev}:${socket.ino}:${socket.ctimeNs}`;
}
