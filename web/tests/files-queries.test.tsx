// ⚠️ The order of imports is MEANING, not formatting: the DOM must stand
// before React is loaded (see `dom-harness.tsx`). The harness next to this
// file loads it first and is therefore imported BEFORE everything else.
import {
  HOST_ID,
  all,
  asked,
  at,
  chooseFile,
  click,
  entry,
  fileOfSize,
  listing,
  mountAt,
  stubHub
} from "./files-view-harness.js";
import { settle } from "./dom-harness.js";

import assert from "node:assert/strict";
import test from "node:test";

// WHAT THIS FILE CHECKS (#263)
//
// Since #263 the file tab loads its share, its candidates and its directories
// through TanStack Query (`web/src/features/files/file-queries.ts`). The cases
// in `files-view.test.tsx` and `files-view-actions.test.tsx` count requests;
// this file checks what a count does not see:
//
//   1. THE NEW LIST IS SHOWN, NOT ONLY ASKED FOR. An invalidation that refetches
//      under a key the view does not read sends the second `GET …/files` and
//      leaves the old list on screen. Both cases below change the hub's answer
//      between the first and the second request and look for the new entry.
//   2. A NAME WITH SPECIAL CHARACTERS KEEPS ITS IDENTITY. The path is part of
//      the query key and of the address; a name with `&`, `#`, `%`, `?` and a
//      space must arrive at the hub as the same name, and the listing under
//      it must be the one shown.
//   3. A LARGE DIRECTORY ARRIVES WHOLE, IN ONE REQUEST. One listing, every row,
//      and the note that the agent cut it off.
//
// NOT checked: the network. `fetch` and `XMLHttpRequest` are stubs.

test("nach dem Löschen zeigt die Liste den neuen Stand und nicht den alten", async () => {
  const listings = {
    "": listing({ entries: [entry({ name: "alt.log" }), entry({ name: "bleibt.txt" })] })
  };
  const server = stubHub({ listings });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.equal(all("files-entry").length, 2, "the list before deleting does not have both entries");
    // The hub's next answer: the file is gone.
    listings[""] = listing({ entries: [entry({ name: "bleibt.txt" })] });

    const trigger = at("files-delete-alt.log");
    assert.ok(trigger !== null, "the delete button is missing");
    await click(trigger);
    const confirm = at("files-delete-submit");
    assert.ok(confirm !== null, "the button in the confirmation is missing");
    await click(confirm);
    await settle();

    const names = all("files-entry-name").map((node) => node.textContent);
    assert.deepEqual(names, ["bleibt.txt"], `the list still shows the old state: ${names.join(", ")}`);
    assert.equal(asked(server, "GET", "/files").length, 2, "the list was not loaded again after deleting");
    assert.ok(at("files-view")?.dataset.refreshing === undefined, "the reload is reported as still running");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("nach dem Hochladen steht die neue Datei in der Liste", async () => {
  const listings = { "": listing({ entries: [entry({ name: "a" })] }) };
  const server = stubHub({ listings });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const field = at("files-upload-input");
    assert.ok(field instanceof HTMLInputElement, "the file field is missing");
    await chooseFile(field, fileOfSize("neu.bin", 40));
    const submit = at("files-upload-submit");
    assert.ok(submit !== null, "the upload button is missing");
    await click(submit);

    listings[""] = listing({ entries: [entry({ name: "a" }), entry({ name: "neu.bin", size: 40 })] });
    const upload = server.uploads[0];
    assert.ok(upload !== undefined, "no upload went out");
    await upload.finish("neu.bin", 40);
    await settle();

    const names = all("files-entry-name").map((node) => node.textContent);
    assert.deepEqual(names, ["a", "neu.bin"], `the uploaded file is not in the list: ${names.join(", ")}`);
    // The receipt survives the reload: the list stayed while it ran (#136).
    assert.ok(at("files-upload-done") !== null, "the receipt of the upload is gone");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein Verzeichnis mit Sonderzeichen im Namen kommt beim Hub unter demselben Namen an", async () => {
  // Every character that would break an address unencoded: `&` starts a
  // parameter, `#` cuts the address, `%` starts an escape, `?` starts a query.
  const odd = "a&b #1 %20 ü?x";
  const inside = "datei & co.txt";
  const server = stubHub({
    listings: {
      "": listing({ entries: [entry({ name: odd, kind: "directory" })] }),
      [odd]: listing({ path: odd, entries: [entry({ name: inside })] })
    }
  });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    const into = at("files-entry-link");
    assert.ok(into !== null, "the way into the directory is missing");
    await click(into);
    await settle();

    const second = asked(server, "GET", "/files")[1];
    assert.ok(second !== undefined, "the directory was not loaded");
    const sent = new URLSearchParams(second.url.slice(second.url.indexOf("?") + 1)).get("path");
    assert.equal(sent, odd, `the hub got a different name: ${String(sent)}`);
    assert.equal(at("files-current-path")?.textContent, odd, "the list does not name the directory it shows");

    const names = all("files-entry-name").map((node) => node.textContent);
    assert.deepEqual(names, [inside], `the list of another directory is shown: ${names.join(", ")}`);
    // The download link of a file in it carries the whole path, encoded once.
    const download = at("files-entry-download");
    assert.ok(download instanceof HTMLAnchorElement, "the download link is missing");
    const href = download.getAttribute("href") ?? "";
    assert.ok(
      href.endsWith(`?path=${encodeURIComponent(`${odd}/${inside}`)}`),
      `the download address does not carry the encoded path: ${href}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein großes Verzeichnis kommt mit einer Anfrage ganz an und sagt, dass es gekürzt ist", async () => {
  const count = 1000;
  const entries = Array.from({ length: count }, (_, index) => entry({ name: `f-${String(index).padStart(4, "0")}` }));
  const server = stubHub({ listings: { "": listing({ entries, truncated: true }) } });
  const mounted = await mountAt(`/container/${HOST_ID}/demo/files`);

  try {
    assert.equal(all("files-entry").length, count, "not every entry of the directory is shown");
    assert.ok(at("files-truncated") !== null, "the note that the agent cut the list off is missing");
    assert.equal(asked(server, "GET", "/files").length, 1, "the directory was loaded more than once");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
