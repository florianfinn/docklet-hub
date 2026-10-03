// A minimal ustar writer for the write path of Web-FTP (S19 — K6).
//
// Why tar at all: `PUT /containers/{id}/archive` is the only engine operation
// that places a file into a container, and it accepts nothing but a tar
// stream. And why this route instead of a simple fs.writeFile:
//
// ⚠️ **Ownership.** The agent runs as `node` (uid 1000) with `cap_drop: ALL`
// — it has no CAP_CHOWN and cannot hand a file it creates over to the service
// that is supposed to read it. A save game owned by the wrong user is, for
// the game server, the same as none at all. The daemon, by contrast, runs as
// root and creates the file with exactly the uid/gid that is in the tar
// header — and the agent reads those beforehand from the TARGET DIRECTORY.
// The uploaded file is thus owned by the same user as its neighbours.
//
// That is no new privilege: the agent has the docker.sock and therefore
// root-equivalent access to the host anyway (docker-compose.yml says so too,
// at the mount of the base path). It is only the way in which this existing
// privilege is used precisely instead of coarsely.
//
// Deliberately no dependency: the agent has no dependency tree (see
// Dockerfile), and pulling in a tar package precisely in the component with
// root-equivalent access would be the wrong trade. Only ONE entry is written
// per call anyway.

export const TAR_BLOCK = 512;

// ustar holds the name in 100 bytes. Longer names need the prefix field or a
// GNU extension — both would be effort here for a case that does not exist:
// what gets written is always ONE entry with ONE name segment, without a
// directory part.
export const TAR_MAX_NAME_BYTES = 100;

export type TarEntry = {
  // A single name segment, not a path. The destination is the directory the
  // engine extracts into — it is in the request, never in the archive.
  name: string;
  kind: "file" | "directory";
  content?: Buffer;
  // Permission bits without file type (i.e. 0o644, not 0o100644).
  mode: number;
  uid: number;
  gid: number;
  // Seconds since the epoch.
  mtime: number;
};

export class TarNameTooLong extends Error {
  constructor(readonly name: string) {
    super(`name longer than ${TAR_MAX_NAME_BYTES} bytes: ${name}`);
    this.name = "TarNameTooLong";
  }
}

// ⚠️ The finding from the S19 security review, and the lesson from it.
//
// `checkName` (webftp.ts) checks the INPUT STRING for `/`, `\` and NUL. But
// what gets written are BYTES — and in between there was a re-encoding: this
// field was written with latin1, which truncates every code unit to its
// low-order byte instead of failing. `"subįĮenv"` thus became the bytes
// `sub/.env`: a name that passed the check and arrives at the daemon as a
// PATH. Every preliminary check (symlink, already-exists, owner inheritance)
// then ran against a location that was never written.
//
// Two consequences, and both are deliberately here instead of only in
// webftp.ts:
//
//   1. Writing uses utf8 — the same encoding the length check measures in
//      anyway. A module that talks about the same string in two encodings has
//      the bug built in.
//   2. The check runs on the BYTES, immediately before they go into the field.
//      The guarantee "a name is not a path" belongs at the place where the
//      name turns into a path — not only at the input. That is the same
//      reasoning for which log-file.ts deliberately does NOT translate
//      backslashes: two interpretations of the same string are the place
//      where traversal checks fail.
export class TarNameInvalid extends Error {
  constructor(readonly name: string) {
    super(`name contains path or null bytes: ${name}`);
    this.name = "TarNameInvalid";
  }
}

// Octal, right-aligned with leading zeros, terminated by a NUL.
// `length` is the field width including that NUL.
function octal(value: number, length: number): string {
  const digits = length - 1;
  const rounded = Math.max(0, Math.floor(value));
  const text = rounded.toString(8);
  if (text.length > digits) {
    // No silent truncation: a clipped size or uid value would be an archive
    // that means something other than intended.
    throw new RangeError(`value ${value} does not fit into ${digits} octal digits`);
  }
  return `${text.padStart(digits, "0")}\0`;
}

// ⚠️ utf8, NOT "binary"/latin1 — see TarNameInvalid. latin1 truncates every
// code unit to its low-order byte (U+012F becomes 0x2F, i.e. `/`), so the
// written bytes would differ from the checked ones. For the other callers of
// this function (octal numbers, "ustar", checksum) the switch makes no
// difference: they are pure ASCII.
function write(block: Buffer, text: string, offset: number, length: number): void {
  block.write(text, offset, length, "utf8");
}

// A single ustar header block. The checksum is computed over the block in
// which the checksum field itself consists of spaces — that is what the format
// prescribes, and the daemon silently rejects any deviation from it.
export function tarHeader(entry: TarEntry): Buffer {
  // Measuring and checking happen on the same bytes that are about to be
  // written — not on the string before them.
  const nameBytes = Buffer.from(entry.name, "utf8");
  if (nameBytes.length === 0 || nameBytes.length > TAR_MAX_NAME_BYTES) {
    throw new TarNameTooLong(entry.name);
  }
  // 0x2F `/`, 0x5C `\`, 0x00 NUL. Fail closed and immediately before writing:
  // from here on the name is a path, and nobody checks it again afterwards.
  if (nameBytes.includes(0x2f) || nameBytes.includes(0x5c) || nameBytes.includes(0x00)) {
    throw new TarNameInvalid(entry.name);
  }

  const block = Buffer.alloc(TAR_BLOCK);
  const size = entry.kind === "directory" ? 0 : (entry.content?.length ?? 0);

  write(block, entry.name, 0, 100);
  // Only the permission bits: the file type is in the typeflag, not the mode.
  write(block, octal(entry.mode & 0o7777, 8), 100, 8);
  write(block, octal(entry.uid, 8), 108, 8);
  write(block, octal(entry.gid, 8), 116, 8);
  write(block, octal(size, 12), 124, 12);
  write(block, octal(entry.mtime, 12), 136, 12);
  // Checksum field during the calculation: eight spaces.
  write(block, "        ", 148, 8);
  write(block, entry.kind === "directory" ? "5" : "0", 156, 1);
  write(block, "ustar\0", 257, 6);
  write(block, "00", 263, 2);
  // uname/gname stay empty. The daemon evaluates the numeric uid/gid; a name
  // would be a second, possibly diverging statement of the same thing — and in
  // the target container its own /etc/passwd applies anyway, not ours.

  let total = 0;
  for (const byte of block) total += byte;
  // Six octal digits, NUL, space — in exactly this order.
  write(block, `${total.toString(8).padStart(6, "0")}\0 `, 148, 8);

  return block;
}

// A complete archive with exactly one entry, including the two zero blocks at
// the end that mark the end of the archive.
export function tarWithOneEntry(entry: TarEntry): Buffer {
  const header = tarHeader(entry);
  const content = entry.kind === "directory" ? Buffer.alloc(0) : (entry.content ?? Buffer.alloc(0));
  const padding = Buffer.alloc((TAR_BLOCK - (content.length % TAR_BLOCK)) % TAR_BLOCK);
  return Buffer.concat([header, content, padding, Buffer.alloc(TAR_BLOCK * 2)]);
}
