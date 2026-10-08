import { renderInDom, settle } from "./dom-harness.js";
import React from "react";
import { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { EditorShell } from "../src/platform/editor/EditorShell.js";
import { clearEditorDrafts, useEditorDocument } from "../src/platform/editor/useEditorDocument.js";
import { applyMaskedEdit, MASK, maskProjection, textWithinLimit } from "../src/platform/editor/masking.js";
import { composeMaskRanges, envMaskRanges } from "../src/features/compose/editor-masks.js";
import { composeEditorAdapter } from "../src/features/compose/editor-adapter.js";
import { envEditorAdapter, envEditorChanges, envEditorContent } from "../src/features/compose/env-editor-adapter.js";
import { fileEditorAdapter } from "../src/features/files/editor-adapter.js";
import { MAX_COMPOSE_BYTES, MAX_TEXT_BYTES } from "contract";

for (const limit of [MAX_COMPOSE_BYTES, MAX_TEXT_BYTES]) {
  test(`UTF-8 boundary ${limit} accepts exact bytes, rejects overflow, NUL and surrogates`, () => {
    assert.equal(textWithinLimit("ä".repeat(limit / 2), limit), true);
    assert.equal(textWithinLimit("ä".repeat(limit / 2) + "x", limit), false);
    assert.equal(textWithinLimit("a\0b", limit), false);
    assert.equal(textWithinLimit("\ud800", limit), false);
  });
}

test("adapters mask case-insensitive sensitive environment values before highlighting", () => {
  const text = "services:\n  web:\n    environment:\n      api_key: synthetic-private-value\n      PUBLIC: visible\n      Password: another-private-value\n";
  const projected = maskProjection(text, composeMaskRanges(text), new Set()).text;
  assert.equal(projected.includes("synthetic-private-value"), false);
  assert.equal(projected.includes("another-private-value"), false);
  assert.equal(projected.includes("visible"), true);
  assert.equal(fileEditorAdapter.ranges(text).length, 0);
  assert.equal(envMaskRanges("export db_secret=value\nToken=other\nPUBLIC=open").length, 2);
  const changed = applyMaskedEdit(text, maskProjection(text, composeMaskRanges(text), new Set()), projected.replace("visible", "edited"));
  assert.equal(changed.includes("synthetic-private-value"), true);
  assert.equal(changed.includes(MASK), false);
  const entries = [{ key: "API_KEY", empty: false }, { key: "PUBLIC", value: "open", empty: false }];
  const content = envEditorContent(entries);
  assert.deepEqual(envEditorChanges(content.replace('"open"', '"edited"'), entries), { set: { PUBLIC: "edited" }, remove: [] });
  assert.throws(() => envEditorChanges(`NEW=${MASK}`, entries), /invalid-env-value/);
  assert.equal(envEditorAdapter.maxBytes, MAX_COMPOSE_BYTES);
  assert.equal(fileEditorAdapter.maxBytes, MAX_TEXT_BYTES);
});

test("the shared shell hides secrets in both textarea and highlighting and reveals one value", async () => {
  const value = "services:\n  web:\n    environment:\n      API_KEY: synthetic-private-value\n      PASSWORD: another-private-value\n";
  const mounted = await renderInDom(<AppLanguageProvider><EditorShell value={value} onChange={() => {}} adapter={composeEditorAdapter} label="text" /></AppLanguageProvider>);
  try {
    assert.equal(mounted.container.textContent?.includes("synthetic-private-value"), false);
    assert.equal(mounted.container.querySelector("textarea")!.value.includes("synthetic-private-value"), false);
    const buttons = [...mounted.container.querySelectorAll("button")];
    await act(async () => buttons[0].click());
    await settle();
    assert.equal(mounted.container.querySelector("textarea")!.value.includes("synthetic-private-value"), true);
    assert.equal(mounted.container.querySelector("textarea")!.value.includes("another-private-value"), false);
  } finally { await mounted.unmount(); }
});

for (const adapter of [composeEditorAdapter, fileEditorAdapter]) {
  test(`the shared shell rejects oversized loads at ${adapter.maxBytes} bytes`, async () => {
    const mounted = await renderInDom(<AppLanguageProvider><EditorShell value={"x".repeat(adapter.maxBytes + 1)} onChange={() => assert.fail("invalid load must not edit")} adapter={adapter} label="text" /></AppLanguageProvider>);
    try {
      assert.equal(mounted.container.querySelector("textarea")!.disabled, true);
      assert.equal(mounted.container.querySelector("textarea")!.value, "");
      assert.equal(mounted.container.querySelector('[role="alert"]') !== null, true);
    } finally { await mounted.unmount(); }
  });
}

let document: ReturnType<typeof useEditorDocument>;
function Document({ target, content = "loaded" }: { target: string; content?: string }) {
  document = useEditorDocument(target, { content, hash: "hash" }, 32);
  return <span>{document.content}</span>;
}

test("drafts survive unmount and refetch, remain target-bound, and clear at session end", async () => {
  clearEditorDrafts();
  let mounted = await renderInDom(<Document target="host/container/source/file" />);
  await act(async () => document.edit("draft"));
  await mounted.unmount();
  mounted = await renderInDom(<Document target="host/container/source/other" />);
  assert.equal(document.content, "loaded");
  await mounted.unmount();
  mounted = await renderInDom(<Document target="host/container/source/file" content="refetched" />);
  assert.equal(document.content, "draft");
  assert.equal(document.hash, "hash");
  await mounted.unmount();
  clearEditorDrafts();
  mounted = await renderInDom(<Document target="host/container/source/file" content="refetched" />);
  assert.equal(document.content, "refetched");
  await mounted.unmount();
});

test("failed saves preserve drafts and a second external change conflicts again", async () => {
  clearEditorDrafts();
  const mounted = await renderInDom(<Document target="conflict-file" />);
  try {
    await act(async () => document.edit("draft"));
    const seen: string[] = [];
    const writer = async (_content: string, hash: string): Promise<{ hash: string }> => { seen.push(hash); throw new Error(seen.length === 1 ? "external-1" : "external-2"); };
    await act(async () => { assert.equal(await document.save(writer, (error) => (error as Error).message), false); });
    assert.equal(document.content, "draft");
    assert.equal(document.conflict, "external-1");
    await act(async () => { assert.equal(await document.save(writer, (error) => (error as Error).message, document.conflict!), false); });
    assert.deepEqual(seen, ["hash", "external-1"]);
    assert.equal(document.conflict, "external-2");
    assert.equal(document.content, "draft");
    await act(async () => document.edit("x".repeat(33)));
    await act(async () => { assert.equal(await document.save(writer, () => null), false); });
    assert.equal(seen.length, 2);
  } finally { await mounted.unmount(); clearEditorDrafts(); }
});

for (const adapter of [composeEditorAdapter, fileEditorAdapter]) {
  test(`the shared shell remains editable at exactly ${adapter.maxBytes} bytes`, async () => {
    const content = "ä".repeat(adapter.maxBytes / 2);
    const mounted = await renderInDom(<AppLanguageProvider><EditorShell value={content} onChange={() => {}} adapter={adapter} label="text" /></AppLanguageProvider>);
    try {
      assert.equal(mounted.container.querySelector("textarea")!.disabled, false);
      assert.equal(mounted.container.querySelector("textarea")!.value, content);
      assert.equal(mounted.container.querySelector('[role="alert"]') === null, true);
    } finally { await mounted.unmount(); }
  });
}

test("incomplete YAML environment values remain masked", () => {
  const content = 'services:\n  app:\n    environment:\n      API_KEY: "unfinished-private-value\n';
  const projection = maskProjection(content, composeMaskRanges(content), new Set()).text;
  assert.equal(projection.includes("unfinished-private-value"), false);
});

test("source blockers and existing-target conflicts use translated explanations", async () => {
  const { MemoryRouter } = await import("react-router");
  const { SourceChooser } = await import("../src/features/files/SourceChooser.js");
  const { fileErrorKey } = await import("../src/features/files/file-errors.js");
  const { ApiError } = await import("../src/platform/http/transport.js");
  const source = { service: "app", kind: "volume" as const, source: "data", target: "/data", readOnly: false, shared: true, sourceId: "data", readable: true, writable: false, writeBlocker: "source-shared" as const, estimatedBytes: null, backupEligible: true, restoreEligible: false, protection: "none" as const, ownership: "shared" as const };
  const mounted = await renderInDom(<AppLanguageProvider><MemoryRouter><SourceChooser sources={[source]} pathname="/files" /></MemoryRouter></AppLanguageProvider>);
  try {
    assert.equal(mounted.container.textContent?.includes("source-shared"), false);
    assert.equal(mounted.container.textContent?.includes("data → /data"), true);
    assert.equal(mounted.container.querySelector("a") !== null, true);
    assert.equal(fileErrorKey(new ApiError(409, JSON.stringify({ reason: "already-exists" }))), "filesBlockerAlreadyExists");
  } finally { await mounted.unmount(); }
});

test("existing-target errors remain visible and keep the proposed name editable", async () => {
  const { CreateDirectory } = await import("../src/features/files/FolderActions.js");
  const { typeInto, listing } = await import("./files-view-harness.js");
  const { de, en } = await import("../src/app/i18n/messages.js");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ reason: "already-exists" }), { status: 409, headers: { "content-type": "application/json" } });
  const mounted = await renderInDom(<AppLanguageProvider><CreateDirectory hostId="host" containerId="container" listing={listing()} onDone={() => assert.fail("conflicts must not succeed")} /></AppLanguageProvider>);
  try {
    const field = mounted.container.querySelector("input")!;
    await typeInto(field, "existing");
    await act(async () => mounted.container.querySelector("button")!.click());
    await settle();
    const error = mounted.container.querySelector('[data-testid="files-create-directory-error"]');
    assert.equal(error !== null, true);
    assert.equal([de.filesBlockerAlreadyExists, en.filesBlockerAlreadyExists].includes(error!.textContent!), true);
    assert.equal(field.value, "existing");
    assert.equal(field.disabled, false);
  } finally { await mounted.unmount(); globalThis.fetch = original; }
});

test("dirty documents install beforeunload protection and remove it on unmount", async () => {
  const mounted = await renderInDom(<AppLanguageProvider><EditorShell value="draft" onChange={() => {}} adapter={fileEditorAdapter} label="text" dirty /></AppLanguageProvider>);
  const leaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  assert.equal(leaving.defaultPrevented, true);
  await mounted.unmount();
  const after = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
});

test("file adapters select YAML, env schema or plain text by extension without masking", async () => {
  const { fileEditorAdapterFor } = await import("../src/features/files/editor-adapter.js");
  for (const path of ["config.yaml", "config.YML", ".env", "nested/.env.example", "plain.txt"]) {
    const adapter = fileEditorAdapterFor(path);
    assert.deepEqual(adapter.ranges("API_KEY=visible"), []);
    const value = path.includes("env") ? "API_KEY=visible\n# comment" : "key: visible";
    const mounted = await renderInDom(<AppLanguageProvider><EditorShell value={value} adapter={adapter} onChange={() => {}} label="text" /></AppLanguageProvider>);
    try {
      assert.equal(mounted.container.querySelector("textarea")!.value, value);
      assert.equal(mounted.container.querySelector('[class*="editor-syntax-"]') !== null, path !== "plain.txt");
    } finally { await mounted.unmount(); }
  }
});

test("single-file mount editors highlight the container filename with an empty relative path", async () => {
  const { FileEditor } = await import("../src/features/files/FileEditor.js");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ text: { path: "", content: "key: visible\n", hash: "actual" } }), { headers: { "content-type": "application/json" } });
  const mounted = await renderInDom(<AppLanguageProvider><QueryClientProvider client={query}>
    <FileEditor hostId="host" containerId="container" path="" syntaxPath="/config/settings.yml" onClose={() => {}} onSaved={() => {}} />
  </QueryClientProvider></AppLanguageProvider>);
  try {
    await settle();
    assert.equal(mounted.container.querySelector("textarea")?.value, "key: visible\n");
    assert.equal(mounted.container.querySelector('[class*="editor-syntax-"]') !== null, true);
  } finally { await mounted.unmount(); query.clear(); globalThis.fetch = fetch; }
});
