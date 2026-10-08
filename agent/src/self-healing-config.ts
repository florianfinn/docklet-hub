import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_SELF_HEALING_CONFIG, selfHealingConfigSchema, type SelfHealingConfig } from "contract";

export class SelfHealingConfigStore {
  private config: SelfHealingConfig;

  constructor(private readonly file: string) {
    try {
      this.config = selfHealingConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      fs.chmodSync(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.config = structuredClone(DEFAULT_SELF_HEALING_CONFIG);
    }
  }

  read(): SelfHealingConfig { return structuredClone(this.config); }

  write(input: SelfHealingConfig): SelfHealingConfig {
    const value = selfHealingConfigSchema.parse(input);
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(value), "utf8");
        fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      const directoryFd = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      this.config = value;
      return this.read();
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
