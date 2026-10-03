// Die Typen für die ZWEI tief adressierten Prism-Dateien.
//
// ⚠️ WARUM NICHT EINFACH `import Prism from "prismjs"`. Dieser Einstieg zieht
// den Kern MIT den vier vorgeladenen Sprachen (markup, css, clike, javascript)
// in das Bündel — vier Grammatiken, von denen diese Fläche keine braucht. Der
// Kern allein plus YAML ist ein Bruchteil davon, und die Compose-Fläche ist der
// einzige Ort im Hub, der überhaupt einfärbt.
//
// ⚠️ `@types/prismjs` DECKT DIESE PFADE NICHT AB. Es beschreibt das Paket unter
// seinem Hauptnamen; `prismjs/components/prism-core.js` ist für den Typprüfer
// ein Modul ohne Typen. Hier steht deshalb genau so viel, wie diese Fläche
// benutzt — `tokenize` und `languages` — und ausdrücklich nicht mehr: eine
// nachgebaute Vollbeschreibung wäre eine zweite Wahrheit über eine fremde
// Bibliothek, und sie veraltete beim nächsten Update, ohne dass etwas rot wird.
//
// ⚠️ `Token.content` IST BEWUSST `unknown`. Prism verschachtelt: der Inhalt
// eines Tokens ist eine Zeichenkette ODER eine Liste aus Zeichenketten und
// weiteren Tokens. Ein zu enger Typ hier lüde dazu ein, die Verschachtelung zu
// übersehen — und `yaml-highlight.ts` löst sie rekursiv auf, weil sonst Text
// verschwindet, nicht bloß Farbe.

declare module "prismjs/components/prism-core.js" {
  export type PrismToken = {
    type: string;
    alias?: string | string[];
    content: unknown;
    length: number;
  };

  const Prism: {
    languages: Record<string, unknown>;
    tokenize: (text: string, grammar: unknown) => unknown[];
  };

  export default Prism;
}

declare module "prismjs/components/prism-yaml.js";
