import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import type { Request } from "express";

import { isJsonBody, readBytes } from "./request-body.js";

// The two things the file routes read from the HTTP request (#262): whether a
// body was announced as JSON, and its bytes under a cap.

const withType = (value: string | undefined): Pick<Request, "headers"> => ({
  headers: value === undefined ? {} : { "content-type": value }
});

test("JSON wird in jeder Schreibweise des Medientyps erkannt", () => {
  for (const type of [
    "application/json",
    "Application/JSON",
    "APPLICATION/JSON; charset=utf-8",
    "application/json;charset=UTF-8"
  ]) {
    assert.equal(isJsonBody(withType(type)), true, type);
  }
});

test("Bytes und Text sind kein JSON, ein fehlender Kopf auch nicht", () => {
  for (const type of ["application/octet-stream", "text/plain; charset=utf-8", "Text/Plain", undefined]) {
    assert.equal(isJsonBody(withType(type)), false, String(type));
  }
});

/** A request as `readBytes` reads it: a stream with `iterator` and `resume`. */
function requestOf(...chunks: string[]): Request {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as unknown as Request;
}

test("ein leerer Rumpf sind null Bytes und kein Fehlschlag", async () => {
  const body = await readBytes(requestOf(), 10);
  assert.ok(body);
  assert.equal(body.length, 0);
});

test("der Rumpf wird gesammelt, solange er unter der Grenze bleibt", async () => {
  const body = await readBytes(requestOf("abc", "de"), 5);
  assert.equal(body?.toString("utf8"), "abcde");
});

test("über der Grenze kommt null, gezählt wird während des Lesens", async () => {
  assert.equal(await readBytes(requestOf("abc", "def"), 5), null);
});
