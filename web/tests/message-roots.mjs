import { existsSync, readdirSync } from "node:fs";

/**
 * Every directory that holds language files (#258): `messagesRoot`
 * (`web/src/platform/i18n/messages/`) and the `messages/` folder of every
 * feature under `featuresRoot`. A feature brings its own `de.ts`/`en.ts`;
 * they are parts of the same language as the platform files, and every
 * assertion of `languages.test.mjs` reads them too.
 *
 * ⚠️ FOUND BY THE FOLDER, NOT BY THE IMPORTS OF `app/i18n/messages.ts`: a
 * feature whose texts nobody puts together is read all the same, and its keys
 * show up as dead instead of lying next to the guard unchecked.
 *
 * A file of its own because `languages.test.mjs` stood at the line limit of
 * `source-file-size.test.mjs`.
 */
export function messageRoots(messagesRoot, featuresRoot) {
  const features = existsSync(featuresRoot)
    ? readdirSync(featuresRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(`${featuresRoot}/${entry.name}/messages`))
        .map((entry) => `${featuresRoot}/${entry.name}/messages`)
        .sort()
    : [];
  return [messagesRoot, ...features];
}
