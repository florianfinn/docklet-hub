import type { Messages } from "use-intl";

import type { Language } from "./languages";

// A byte count as a readable size. Used by the file list, the upload, the
// metrics of a container and the load of an arm.
//
// It stood in `screens/container/files/file-entries.ts` as `entrySize` until
// #263. With the files moving to `features/files/` it could not stay there: the
// metrics and the host card would have imported a feature for a number format
// (`docs/design/feature-architecture.md`, section 3, rule 1). It holds no
// knowledge about files, so it belongs to the i18n frame in `platform/`. The
// four unit texts (`fileSizeBytes` …) stay in `platform/i18n/messages/` for the
// same reason.

/**
 * How many bytes, in the largest unit in which the number stays small.
 *
 * ⚠️ BINARY PREFIXES (KiB, MiB, GiB), NOT DECIMAL ONES. A file size comes from
 * `stat.size` of a file system, and that is read as binary everywhere in
 * operation — `ls -lh` and `du -h` show the same number. A decimal display next
 * to them would be off by 2.4 %, and invisibly so.
 *
 * Returns a PAIR of text key and formatted number: the unit sentence
 * ("{value} KiB") stands in the language files and not here, because the order
 * of number and unit is not the same in every language.
 */
export function byteSize(size: number, language: Language): { key: keyof Messages; value: string } {
  const format = (value: number, digits: number): string =>
    new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);

  if (size < 1024) return { key: "fileSizeBytes", value: format(size, 0) };
  if (size < 1024 * 1024) return { key: "fileSizeKibibytes", value: format(size / 1024, 1) };
  if (size < 1024 * 1024 * 1024) return { key: "fileSizeMebibytes", value: format(size / (1024 * 1024), 1) };
  return { key: "fileSizeGibibytes", value: format(size / (1024 * 1024 * 1024), 2) };
}
