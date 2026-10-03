import { createLocalAccountIssuer, generateId } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import "dotenv/config";
import type { Pool } from "pg";

import { ConfigError, loadConfig } from "../config/config.js";
import { createPool } from "../db/pool.js";
import { HELP, parseArguments, type ParsedArguments } from "./break-glass-args.js";
import { createPassword } from "./password-generator.js";

// Der zweite Weg zum Admin: das Break-Glass.
//
// Er gilt dem AUSGESPERRTEN Betrieb und ist nicht dasselbe wie die
// Erstanmeldung, die dem frischen gilt (setup-gate.ts). Beide werden gern
// verwechselt, und der Unterschied ist der Punkt: die Erstanmeldung steht
// offen, solange es nichts zu schützen gibt, und schließt danach für immer.
// Das Break-Glass gilt genau dann, wenn es etwas zu schützen gibt und niemand
// mehr hineinkommt.
//
// Deshalb läuft es OHNE Weboberfläche. Das System, über das man sich sonst
// wieder hereinließe, ist ja genau dieses. Was es stattdessen verlangt, ist
// Zugang zum Container — und wer den hat, hat ohnehin Zugang zur Datenbank.
//
// ⚠️ Es schreibt in dieselben Tabellen wie better-auth, nicht daneben. Der
// Passwort-Hash entsteht deshalb mit derselben Funktion (`hashPassword`), und
// das Konto bekommt dieselbe Kontozeile mit demselben Aussteller. Ein
// selbstgebauter Hash wäre ein Konto, das dieses Werkzeug anlegt und die
// Anmeldung nicht kennt.

const CREDENTIAL_PROVIDER = "credential";

type UserRow = { id: string; email: string; name: string; role: string; createdAt: Date };

async function findUser(pool: Pool, email: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT "id", "email", "name", "role", "createdAt" FROM "user" WHERE "email" = $1`,
    [email]
  );
  return rows[0] ?? null;
}

async function listUsers(pool: Pool): Promise<void> {
  const { rows } = await pool.query<UserRow>(
    `SELECT "id", "email", "name", "role", "createdAt" FROM "user" ORDER BY "createdAt"`
  );
  if (rows.length === 0) {
    console.log(
      "Kein Konto vorhanden. Damit steht die Erstanmeldung offen — der Hub führt sie beim ersten Aufruf im Browser."
    );
    return;
  }
  for (const row of rows) {
    console.log(`${row.role.padEnd(5)}  ${row.email}  (${row.name})`);
  }
}

/**
 * Setzt ein neues Passwort und beendet alle Sitzungen des Kontos.
 *
 * Die Sitzungen gehören dazu und sind kein Beiwerk: wer ausgesperrt war,
 * weiß nicht, ob jemand anders drin ist. Ein neues Passwort allein ließe eine
 * bestehende Sitzung unberührt weiterlaufen.
 */
async function setPassword(pool: Pool, user: UserRow, password: string): Promise<void> {
  const hash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE "account"
          SET "password" = $2, "updatedAt" = now()
        WHERE "userId" = $1 AND "providerId" = $3`,
      [user.id, hash, CREDENTIAL_PROVIDER]
    );
    if (updated.rowCount === 0) {
      // Ein Konto ohne Kontozeile mit Passwort — etwa aus einem späteren
      // Anmeldeweg. Es bekommt hier eine, statt dass der Befehl behauptet,
      // etwas getan zu haben.
      await client.query(
        `INSERT INTO "account" ("id", "issuer", "accountId", "providerId", "userId", "password")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [generateId(), createLocalAccountIssuer(CREDENTIAL_PROVIDER), user.id, CREDENTIAL_PROVIDER, user.id, hash]
      );
    }
    await client.query(`DELETE FROM "session" WHERE "userId" = $1`, [user.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function reportPassword(email: string, password: string): void {
  console.log(`Konto:    ${email}`);
  console.log(`Passwort: ${password}`);
  console.log("");
  console.log(
    "Dieses Passwort steht genau einmal hier. Es wird nicht protokolliert und lässt sich nicht erneut anzeigen — nur neu erzeugen."
  );
}

async function createAdmin(pool: Pool, email: string, name: string): Promise<void> {
  if (await findUser(pool, email)) {
    throw new Error(`Es gibt bereits ein Konto für ${email}. „promote" macht es zum Admin, „reset-password" setzt sein Passwort neu.`);
  }
  const password = createPassword();
  const hash = await hashPassword(password);
  const userId = generateId();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "role") VALUES ($1, $2, $3, true, 'admin')`,
      [userId, name, email]
    );
    await client.query(
      `INSERT INTO "account" ("id", "issuer", "accountId", "providerId", "userId", "password")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [generateId(), createLocalAccountIssuer(CREDENTIAL_PROVIDER), userId, CREDENTIAL_PROVIDER, userId, hash]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // ⚠️ `emailVerified` steht auf `true`. Es gibt in diesem System keinen
  // Bestätigungsweg für eine Adresse, die ein Betreiber gerade selbst auf der
  // Kommandozeile eingetippt hat — ein `false` hier wäre ein Zustand, aus dem
  // nichts herausführt.
  reportPassword(email, password);
}

async function promote(pool: Pool, email: string): Promise<void> {
  const user = await findUser(pool, email);
  if (!user) throw new Error(`Kein Konto für ${email}. „create-admin" legt eins an.`);
  if (user.role === "admin") {
    console.log(`${email} ist bereits Admin — nichts zu tun.`);
    return;
  }
  await pool.query(`UPDATE "user" SET "role" = 'admin', "updatedAt" = now() WHERE "id" = $1`, [user.id]);
  console.log(`${email} ist jetzt Admin.`);
}

async function resetPassword(pool: Pool, email: string): Promise<void> {
  const user = await findUser(pool, email);
  if (!user) throw new Error(`Kein Konto für ${email}. „create-admin" legt eins an.`);
  const password = createPassword();
  await setPassword(pool, user, password);
  console.log("Alle Sitzungen dieses Kontos wurden beendet.");
  reportPassword(email, password);
}

async function run(parsed: Extract<ParsedArguments, { kind: "command" }>, pool: Pool): Promise<void> {
  switch (parsed.command) {
    case "list":
      return listUsers(pool);
    case "create-admin":
      return createAdmin(pool, parsed.email, parsed.name);
    case "promote":
      return promote(pool, parsed.email);
    case "reset-password":
      return resetPassword(pool, parsed.email);
  }
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(HELP);
    return;
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    console.error("");
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await run(parsed, pool);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`Break-Glass abgebrochen: ${error.message}`);
  } else {
    console.error("Break-Glass abgebrochen:", error instanceof Error ? error.message : error);
  }
  process.exit(1);
});
