import { randomInt } from "node:crypto";

// Ein erzeugtes Passwort für das Break-Glass.
//
// Es wird abgetippt, oft von einem Bildschirm neben der Tastatur. Deshalb
// fehlen die Zeichen, die man sich beim Abtippen verliest — 0/O, 1/l/I — und
// deshalb steht es in Gruppen: eine falsch gelesene Stelle fällt in einer
// Fünfergruppe auf, in einer Kette aus 24 Zeichen nicht.
//
// `randomInt` aus node:crypto und nicht `Math.random`: das hier ist der
// Zugang zu einem System, das eine Shell auf dem Host öffnet.

const ALPHABET = "abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";

const GROUPS = 5;
const GROUP_LENGTH = 5;

/**
 * Erzeugt ein Passwort aus {@link GROUPS} Gruppen zu {@link GROUP_LENGTH}
 * Zeichen, getrennt durch Bindestriche.
 *
 * 25 Zeichen aus einem Alphabet von 56 sind rund 145 Bit — weit über allem,
 * was hier je gebraucht wird, und trotzdem noch abtippbar. Die Länge liegt
 * damit auch über der Mindestlänge, die auth.ts verlangt; das ist Absicht und
 * kein Zufall, sonst erzeugte dieses Werkzeug Passwörter, die die eigene
 * Anmeldung ablehnt.
 */
export function createPassword(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let value = "";
    for (let position = 0; position < GROUP_LENGTH; position += 1) {
      value += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(value);
  }
  return groups.join("-");
}

// Für den Test: er soll die Zusagen dieser Datei prüfen können, ohne sie zu
// wiederholen.
export const PASSWORD_ALPHABET = ALPHABET;
export const PASSWORD_LENGTH = GROUPS * GROUP_LENGTH + (GROUPS - 1);
