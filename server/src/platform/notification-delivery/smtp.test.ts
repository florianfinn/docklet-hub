import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { after, before, test, type TestContext } from "node:test";
import { sendNotification, type NotificationMessage, type NotificationRuntimeConfig } from "./index.js";
import { sendSmtp } from "./smtp.js";

type SmtpConfig = Extract<NotificationRuntimeConfig, { kind: "smtp" }>;
const message: NotificationMessage = { title: "Example incident ✓", requiredText: "target\ncause\ntime\naction",
  optionalText: ".dot line\nBcc: text@example.invalid", idempotencyKey: "episode:example-1" };
let directory: string;
let key: string;
let cert: string;
before(() => {
  directory = mkdtempSync(join(tmpdir(), "notification-tls-"));
  // Ephemeral synthetic certificate, trusted only by the internal test seam.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=smtp.example.invalid", "-addext", "subjectAltName=IP:127.0.0.1,DNS:smtp.example.invalid",
    "-keyout", join(directory, "key"), "-out", join(directory, "cert")], { stdio: "ignore" });
  key = readFileSync(join(directory, "key"), "utf8");
  cert = readFileSync(join(directory, "cert"), "utf8");
});
after(() => rmSync(directory, { recursive: true, force: true }));
interface FixtureOptions {
  mode: "tls" | "starttls" | "plain";
  reject?: number;
  authReject?: number;
  hang?: boolean;
  abrupt?: boolean;
  partial?: boolean;
  oversized?: boolean;
}
async function smtpFixture(t: TestContext, options: FixtureOptions) {
  const sockets = new Set<Socket>();
  const commands: { line: string; encrypted: boolean }[] = [];
  const bodies: string[] = [];
  let closed = 0;
  function protocol(socket: Socket, encrypted: boolean, greet: boolean) {
    let buffer = "";
    let data = false;
    let body = "";
    let recipients = 0;
    if (greet && !options.hang) socket.write(options.oversized ? "220 " + "x".repeat(20_000) : "220 smtp.example.invalid ESMTP\r\n");
    socket.on("error", () => {});
    const receive = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") { data = false; bodies.push(body); socket.write(`${options.reject ?? 250} message result\r\n`); }
          else body += `${line}\r\n`;
          continue;
        }
        commands.push({ line, encrypted });
        if (options.abrupt) { socket.destroy(); return; }
        if (line.startsWith("EHLO")) socket.write(`250-smtp.example.invalid\r\n${!encrypted && options.mode === "starttls" ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN\r\n`);
        else if (line === "STARTTLS") {
          if (options.mode === "plain") socket.write("500 TLS unavailable\r\n");
          else {
            socket.removeListener("data", receive);
            socket.write("220 upgrade\r\n", () => {
              const secured = new TLSSocket(socket, { isServer: true, key, cert });
              protocol(secured, true, false);
            });
          }
          return;
        } else if (line.startsWith("AUTH")) socket.write(`${options.authReject ?? 235} authentication result\r\n`);
        else if (line.startsWith("MAIL FROM")) socket.write("250 sender accepted\r\n");
        else if (line.startsWith("RCPT TO")) {
          recipients++; socket.write(options.partial && recipients === 2 ? "550 recipient rejected\r\n" : "250 recipient accepted\r\n");
        } else if (line === "DATA") { data = true; socket.write("354 data\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    };
    socket.on("data", receive);
  }
  function track(socket: Socket) {
    sockets.add(socket);
    socket.once("close", () => { closed++; sockets.delete(socket); });
  }
  const server = options.mode === "tls" ? createTlsServer({ key, cert }, (socket) => protocol(socket, true, true)) :
    createServer((socket) => protocol(socket, false, true));
  server.on("connection", track);
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.close(); await once(server, "close"); });
  const config: SmtpConfig = { kind: "smtp", host: "127.0.0.1", port: address.port,
    security: options.mode === "tls" ? "tls" : "starttls", username: "synthetic-user", password: "synthetic-password",
    from: "hub@example.invalid", to: ["operator@example.invalid"] };
  return { config, commands, bodies, closed: () => closed };
}
const signal = () => new AbortController().signal;

test("SMTP actual verified TLS and mandatory STARTTLS encode MIME safely", async (t) => {
  for (const mode of ["tls", "starttls"] as const) {
    const fixture = await smtpFixture(t, { mode });
    assert.deepEqual(await sendSmtp(fixture.config, message, signal(), cert), { status: "delivered" });
    assert.ok(fixture.commands.some((command) => command.line.startsWith("AUTH") && command.encrypted));
    assert.ok(!fixture.commands.some((command) => command.line.startsWith("AUTH") && !command.encrypted));
    assert.ok(fixture.commands.some((command) => command.line === "MAIL FROM:<hub@example.invalid>"));
    assert.equal(fixture.bodies.length, 1);
    const [headers, body] = fixture.bodies[0].split("\r\n\r\n");
    assert.match(headers, /X-Idempotency-Key: episode:example-1/u);
    assert.match(headers, /Subject: =\?UTF-8\?/iu);
    assert.ok(!/^Bcc:/mu.test(headers));
    assert.match(body, /\.\.dot line/u);
    if (mode === "starttls") assert.ok(fixture.commands.some((command) => command.line === "STARTTLS"));
  }
});

test("SMTP rejects untrusted certificates and cannot send without STARTTLS", async (t) => {
  const tls = await smtpFixture(t, { mode: "tls" });
  const outcome = await sendNotification(tls.config, message, signal());
  assert.equal(outcome.status, "failed");
  assert.equal(tls.bodies.length, 0);
  assert.ok(!tls.commands.some((command) => command.line.startsWith("AUTH")));
  const plain = await smtpFixture(t, { mode: "plain" });
  assert.deepEqual(await sendSmtp(plain.config, message, signal(), cert), { status: "failed", failure: "destination-rejected" });
  assert.equal(plain.bodies.length, 0);
  assert.ok(!plain.commands.some((command) => command.line.startsWith("AUTH")));
});

test("SMTP classifies actual transient, authentication and permanent rejections without raw details", async (t) => {
  for (const [options, failure] of [
    [{ reject: 450 }, "transient"], [{ reject: 550 }, "destination-rejected"],
    [{ authReject: 535 }, "authentication"], [{ authReject: 454 }, "transient"], [{ abrupt: true }, "transient"], [{ oversized: true }, "destination-rejected"]
  ] as const) {
    const fixture = await smtpFixture(t, { mode: "tls", ...options });
    assert.deepEqual(await sendSmtp(fixture.config, message, signal(), cert), { status: "failed", failure });
  }
});

test("SMTP partial recipient acceptance is a visible failure", async (t) => {
  const fixture = await smtpFixture(t, { mode: "tls", partial: true });
  assert.deepEqual(await sendSmtp({ ...fixture.config, to: ["one@example.invalid", "two@example.invalid"] }, message, signal(), cert),
    { status: "failed", failure: "destination-rejected" });
});

test("SMTP abort closes a live greeting socket; pre-abort sends nothing", async (t) => {
  const fixture = await smtpFixture(t, { mode: "starttls", hang: true });
  assert.deepEqual(await sendNotification(fixture.config, message, AbortSignal.timeout(100)), { status: "failed", failure: "timeout" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.closed(), 1);
  assert.deepEqual(await sendNotification(fixture.config, message, AbortSignal.abort()), { status: "failed", failure: "timeout" });
});

test("SMTP guards prevent address, auth and subject injection before network access", async (t) => {
  const fixture = await smtpFixture(t, { mode: "tls" });
  for (const override of [{ from: "hub@example.invalid\r\nBcc: injected" }, { to: ["operator@example.invalid,other@example.invalid"] },
    { username: "user\nInjected" }, { password: "password\rInjected" }, { username: null }, { port: 0 },
    { security: "plain" as SmtpConfig["security"] }]) {
    assert.deepEqual(await sendNotification({ ...fixture.config, ...override }, message, signal()), { status: "failed", failure: "validation" });
  }
  assert.deepEqual(await sendNotification(fixture.config, { ...message, title: "Incident\r\nBcc: injected" }, signal()), { status: "failed", failure: "validation" });
  assert.equal(fixture.commands.length, 0);
});

test("SMTP absolute deadline closes a real hanging socket after 15 seconds", { timeout: 18_000 }, async (t) => {
  const fixture = await smtpFixture(t, { mode: "starttls", hang: true });
  const start = performance.now();
  assert.deepEqual(await sendNotification(fixture.config, message, signal()), { status: "failed", failure: "timeout" });
  assert.ok(performance.now() - start >= 14_900);
  assert.ok(performance.now() - start < 16_500);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.closed(), 1);
});


test("HTTPS refuses an untrusted local certificate without transmitting credentials", async (t) => {
  let received = 0;
  const server = createHttpsServer({ key, cert }, (_request, response) => { received++; response.end(); });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, "close"); });
  assert.deepEqual(await sendNotification({ kind: "webhook", endpoint: `https://127.0.0.1:${address.port}`,
    authorization: "Bearer synthetic-token" }, message, signal()), { status: "failed", failure: "transient" });
  assert.equal(received, 0);
});

test("SMTP permits a verified TLS relay without authentication", async (t) => {
  const fixture = await smtpFixture(t, { mode: "tls" });
  assert.deepEqual(await sendSmtp({ ...fixture.config, username: null, password: null }, message, signal(), cert), { status: "delivered" });
  assert.ok(!fixture.commands.some((command) => command.line.startsWith("AUTH")));
});
