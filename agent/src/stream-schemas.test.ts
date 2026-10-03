import test from "node:test";
import assert from "node:assert/strict";

import {
  composeApplyStreamLineSchema,
  execStreamLineSchema,
  logFileStreamLineSchema,
  logsStreamLineSchema,
  monitorEventLineSchema,
  pullStreamLineSchema
} from "contract";

// The stream lines of the agent against the schemas in `contract` (#272).
// Each sample is a line in the wire form its handler writes (the `sendLine`
// calls in `routes/`), kept here as text. The contract test
// (`server/src/agent/agent-roundtrip.test.ts`) runs the handlers themselves;
// this file holds the wire form still, so a schema change that would refuse a
// line an agent of this version sends shows up here and not on a host.

const SAMPLES: { stream: string; schema: { safeParse(value: unknown): { success: boolean } }; lines: string[] }[] = [
  {
    stream: "logs-stream",
    schema: logsStreamLineSchema,
    lines: [
      `{"kind":"start","containerName":"jellyfin","tty":false}`,
      `{"kind":"line","stream":"stdout","ts":"2026-09-07T10:00:00.123456789Z","text":"[INF] Startup complete"}`,
      `{"kind":"line","stream":"stderr","ts":null,"text":"warn"}`,
      `{"kind":"error","reason":"container-gone"}`
    ]
  },
  {
    stream: "log-file",
    schema: logFileStreamLineSchema,
    lines: [
      `{"kind":"start","containerName":"valheim","path":"logs/server.log"}`,
      `{"kind":"line","ts":null,"text":"Game server connected"}`,
      `{"kind":"line","ts":null,"text":"Loading wor","partial":true}`,
      `{"kind":"error","reason":"log-file-failed"}`
    ]
  },
  {
    stream: "pull-stream",
    schema: pullStreamLineSchema,
    lines: [
      `{"kind":"start","imageRef":"lscr.io/linuxserver/jellyfin:10.10.7"}`,
      `{"kind":"progress","status":"Downloading","id":"a1b2c3d4e5f6","progress":"[==>   ] 12.3MB/80MB"}`,
      `{"kind":"progress","status":"Status: Image is up to date","id":null,"progress":null}`,
      `{"kind":"result","ok":true,"imageRef":"lscr.io/linuxserver/jellyfin:10.10.7","imageChanged":true,"recreateRequired":true,"imageMutability":"tag"}`,
      `{"kind":"error","reason":"image-not-found"}`
    ]
  },
  {
    stream: "compose-raw-stream",
    schema: composeApplyStreamLineSchema,
    lines: [
      `{"kind":"start","projectDir":"/home/docker/arr","composeFileName":"compose.yaml","stackName":"arr"}`,
      `{"kind":"step","step":"start"}`,
      `{"kind":"step","step":"pull-images","detail":"ghcr.io/hotio/sonarr:release"}`,
      `{"kind":"result","status":200,"body":{"ok":true,"services":["sonarr","radarr"]}}`,
      `{"kind":"result","status":400,"body":{"error":"compose-hash-missing"}}`,
      `{"kind":"error","reason":"compose-raw-failed"}`
    ]
  },
  {
    stream: "exec",
    schema: execStreamLineSchema,
    lines: [
      `{"kind":"start","session":"${"a".repeat(64)}","shell":"bash","containerName":"nginx"}`,
      `{"kind":"output","text":"root@nginx:/# "}`,
      `{"kind":"end","exitCode":0}`,
      `{"kind":"end","exitCode":null}`
    ]
  },
  {
    stream: "monitor-events",
    schema: monitorEventLineSchema,
    lines: [`{"action":"die","containerId":"${"b".repeat(64)}"}`]
  }
];

test("jede aufgezeichnete Zeile jedes Stroms erfüllt ihr Schema", () => {
  for (const { stream, schema, lines } of SAMPLES) {
    for (const line of lines) {
      assert.equal(schema.safeParse(JSON.parse(line)).success, true, `${stream}: ${line}`);
    }
  }
});

test("eine unbekannte Art wird mit einem Issue auf „kind“ abgelehnt", () => {
  for (const schema of [logsStreamLineSchema, logFileStreamLineSchema, pullStreamLineSchema, composeApplyStreamLineSchema, execStreamLineSchema]) {
    const result = schema.safeParse({ kind: "neu", text: "x" });
    assert.equal(result.success, false);
    const [issue] = result.error?.issues ?? [];
    assert.deepEqual(issue?.path, ["kind"]);
    assert.equal(issue?.code, "invalid_union");
  }
});

test("ein unbekannter Fehlerschlüssel geht wörtlich als reason durch", () => {
  // The enums type what the agent sends; the reader must not drop a key a
  // newer agent adds (streams.ts, `failureLine`).
  for (const schema of [logsStreamLineSchema, logFileStreamLineSchema, pullStreamLineSchema, composeApplyStreamLineSchema]) {
    assert.deepEqual(schema.parse({ kind: "error", reason: "ganz-neuer-grund" }), {
      kind: "error",
      reason: "ganz-neuer-grund"
    });
  }
});
