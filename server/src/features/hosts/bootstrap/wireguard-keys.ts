import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

// Schlüsselerzeugung für den Tunnel — ohne `wg genkey` und ohne eine
// Abhängigkeit dafür.
//
// WireGuard-Schlüssel SIND X25519-Schlüssel; das Werkzeug `wg` erzeugt 32
// zufällige Bytes und gibt sie base64-kodiert aus. Node kann dasselbe über
// die eingebaute Kryptographie, und damit hat der Hub keinen Fremdprozess im
// Weg — auf einem Host ohne installiertes `wireguard-tools` wäre der Aufruf
// sonst genau dann nicht da, wenn der erste Arm angebunden wird.
//
// ⚠️ Die Exportform ist der Punkt, an dem das still schiefgeht: Node liefert
// DER (SPKI bzw. PKCS#8), WireGuard erwartet die 32 ROHEN Bytes. Wer die
// DER-Form base64 ausgibt, bekommt eine Zeichenkette, die aussieht wie ein
// Schlüssel — 60 statt 44 Zeichen — und die `wg-quick` mit „Key is not the
// correct length or format" abweist, erst auf dem Zielhost.

const RAW_KEY_BYTES = 32;

// Die festen DER-Köpfe vor den Rohbytes (RFC 8410, OID 1.3.101.110).
// Sie stehen hier, damit ein anderes Ergebnis von `export` auffällt, statt
// als „letzte 32 Bytes" stillschweigend etwas Falsches zu liefern.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export type WireGuardKeyPair = {
  /** Base64 der 32 Rohbytes, Format von `wg genkey`. */
  privateKey: string;
  /** Base64 der 32 Rohbytes, Format von `wg pubkey`. */
  publicKey: string;
};

function rawFromDer(der: Buffer, prefix: Buffer, label: string): string {
  if (der.length !== prefix.length + RAW_KEY_BYTES || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error(`Unerwartete DER-Form beim Export des ${label} (${der.length} Bytes)`);
  }
  return der.subarray(prefix.length).toString("base64");
}

function derFromRaw(base64: string, prefix: Buffer, label: string): Buffer {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== RAW_KEY_BYTES) {
    throw new Error(`${label} hat ${raw.length} statt ${RAW_KEY_BYTES} Bytes`);
  }
  return Buffer.concat([prefix, raw]);
}

/** Ein frisches Paar für genau einen Arm. Der private Teil wird nicht gespeichert. */
export function generateWireGuardKeyPair(): WireGuardKeyPair {
  const pair = generateKeyPairSync("x25519");
  return {
    privateKey: rawFromDer(pair.privateKey.export({ type: "pkcs8", format: "der" }), PKCS8_PREFIX, "privaten Schlüssels"),
    publicKey: rawFromDer(pair.publicKey.export({ type: "spki", format: "der" }), SPKI_PREFIX, "öffentlichen Schlüssels")
  };
}

/**
 * Der öffentliche Schlüssel zu einem privaten, wie `wg pubkey`.
 *
 * Damit lässt sich ein Paar gegenprüfen, ohne es neu zu erzeugen — der Fall,
 * in dem `wg0.conf` des Arms und der `[Peer]`-Eintrag im Hub auseinanderlaufen,
 * sieht sonst auf beiden Seiten richtig aus und ergibt nur einen Tunnel, der
 * ohne Fehlermeldung nichts überträgt.
 */
export function publicKeyFromPrivate(privateKey: string): string {
  const der = derFromRaw(privateKey, PKCS8_PREFIX, "Der private Schlüssel");
  const key = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  return rawFromDer(key.export({ type: "spki", format: "der" }), SPKI_PREFIX, "öffentlichen Schlüssels");
}
