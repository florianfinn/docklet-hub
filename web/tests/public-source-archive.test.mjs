import test from "node:test";
import assert from "node:assert/strict";
import { inspectText } from "../../scripts/check-publication.mjs";
import { inspectPublicSourceArchive } from "../../scripts/check-publication-archive.mjs";

function zipEntry(name, text) {
  const filename = Buffer.from(name);
  const data = Buffer.from(text);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, directory, filename, end]);
}

test("das öffentliche Quellarchiv prüft Klartext statt nur ZIP-Bytes", () => {
  const secret = "ghp_" + "x".repeat(36);
  const findings = inspectPublicSourceArchive(zipEntry("src/example.ts", secret), inspectText);
  assert.equal(findings[0].category, "credential-pattern");
  assert.equal(JSON.stringify(findings).includes(secret), false);
  assert.deepEqual(inspectPublicSourceArchive(zipEntry("src/example.ts", "synthetic example"), inspectText), []);
});

test("kaputte Archive und unsichere Eintragspfade fallen", () => {
  for (const archive of [Buffer.from("broken"), zipEntry("../escape.ts", "example"), zipEntry("/absolute.ts", "example")]) {
    assert.equal(inspectPublicSourceArchive(archive, inspectText)[0].category, "invalid-public-source-archive");
  }
});

test("der öffentliche Lizenzkontakt erlaubt keine anderen E-Mail-Zeilen", () => {
  const contact = ["eemeli", "gmail.com"].join("@");
  const path = "docs/next/mockups/THIRD-PARTY-LICENSES.txt";
  const notice = "Copyright Eemeli Aro <" + contact + ">";
  assert.deepEqual(inspectText(notice, path), []);
  assert.equal(inspectText(notice, "unrelated.txt")[0].category, "non-example-email");
  assert.equal(inspectText(notice + "\nContact: " + contact, path).length, 1);
  assert.equal(inspectText(notice.replace(contact, ["operator", "corp.invalid-domain"].join("@")), path).length, 1);
});
