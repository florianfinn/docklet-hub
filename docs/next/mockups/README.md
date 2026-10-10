# Opus design mockups

Two clickable Angular/ZardUI design references with synthetic demo data:

| Direction | Open in a browser |
| --- | --- |
| Compact | [opus-compact.html](opus-compact.html) |
| Arcane | [opus-arcane.html](opus-arcane.html) |

Download an HTML file and open it locally in a current browser supporting
`DecompressionStream`. Each file embeds both routes, scripts and styles; no dev
server is needed. GitHub displays the file source rather than running it.
Navigation, hover effects and simulated actions are part of the supplied mockups.
They do not operate Docker hosts, install agents or connect to application APIs.
Refreshing resets in-memory changes. Installation commands and credentials shown
in the UI are examples, not operational instructions.

## Editable source

[opus-source.zip](opus-source.zip) contains the Angular project, both variants,
shared Zard components, configuration, dependency lockfile and third-party
notices. Extract it, run `pnpm install --frozen-lockfile`, then `pnpm start`.
Open `/#/opus-compact` or `/#/opus-arcane`. To build, run `pnpm build`.
The archive excludes dependencies, build caches, reference repository clones and
private generation instructions.

The variant files were copied unchanged from the supplied `opus-pc` project on
2026-10-10. That handoff has no Git revision; a full upstream commit SHA is not
available. [source-manifest.json](source-manifest.json) records each original
variant path and SHA-256 checksum for comparison. It identifies the supplied
source snapshot, rather than an upstream release.

Two scaffold adaptations allow portable packaging: the Angular router uses hash
locations, and the global Zard stylesheet import explicitly names `zard.css`.
The PostCSS configuration is included so Tailwind compiles the original classes.
No variant layouts or interactions were changed. These references may differ
from the agreed product requirements; the decisions in the parent folder remain
the implementation contract.

## Licenses and export

Zard components retain their source paths, full source commit SHA, retrieval date
and adaptation comments. Their license and checksum manifest are included under
`third-party/` in the source archive. The CSS provenance is recorded there too.
[THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt) preserves the dependency notices
extracted by Angular for the generated HTML files. Repository licensing applies
to the original mockup code; third-party notices remain applicable.

The portable export bundles Angular's production entry and lazy chunks into a
single browser IIFE, compresses it with gzip and embeds it with the gzip-compressed compiled CSS.
Its loader decompresses the bundle and selects the requested route. The archive
contains `export-portable.mjs`; after building, install esbuild 0.28.2 without
saving it to the project, then run `node export-portable.mjs`. Generated HTML files
are written to `portable/`.
