import test, { type TestContext } from "node:test";
import https, { type RequestOptions } from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import type { ClientRequest, IncomingMessage } from "node:http";
import nodemailer from "nodemailer";
import assert from "node:assert/strict";
import { DEFAULT_NOTIFICATION_FORMAT, NOTIFICATION_LIMITS, NOTIFICATION_CHANNELS } from "contract";
import { sendNotification, type NotificationMessage, type NotificationRuntimeConfig } from "../../platform/notification-delivery/index.js";
import { renderNotificationMessage } from "./message.js";
import type { NotificationDeliverySnapshot } from "./delivery-types.js";

function snapshot(): NotificationDeliverySnapshot {
  return { ticket: { id:"ticket-a",episodeKey:"episode-a",event:"connection-lost",target:{ kind:"host",hostId:"host-a" },
    targetLabel:"Synthetischer Host",cause:"Verbindung unterbrochen",action:"check-connection",state:"open",
    openedAt:"2026-01-02T00:00:00.000Z",acknowledgedAt:null,resolvedAt:null,affectedContainers:[],affectedContainerCount:0,
    pendingDeliveryCount:0,evidence:{ logs:{ state:"unavailable",reason:"not-collected" } } },
  format:DEFAULT_NOTIFICATION_FORMAT,options:{ includeLogs:false,recovery:false,additionalText:"" },destinationScopeKey:null,bindingDigest:"synthetic-digest" };
}
const identity={ id:"delivery-a",generation:0,channel:"webhook" as const,phase:"initial" as const };
const render=(input: NotificationDeliverySnapshot) => renderNotificationMessage(input,identity);
const escaped=(value: string) => value.replace(/[\\`*_{}[\]()<>#+.!|~-]/gu,"\\$&");

test("all channels retain four literal required values with UTC time and German action",()=>{
  for(const channel of NOTIFICATION_CHANNELS) {
    const input=snapshot(); const message=renderNotificationMessage(input,{ ...identity,channel });
    assert.equal(message.requiredText,"Synthetischer Host\nVerbindung unterbrochen\n2026-01-02T00:00:00.000Z\nVerbindung zum Host prüfen.");
    assert.equal(message.title,"docklet hub: Ereignis"); assert.equal(message.optionalText,undefined);
    assert.match(message.idempotencyKey,/^[A-Za-z0-9._:-]{1,200}$/u);
    assert.ok(!JSON.stringify(message).includes("bindingDigest")); assert.ok(!JSON.stringify(message).includes("destinationScopeKey"));
  }
});

test("recovery and saved test notifications have clear phases; ack does not alter admitted initial content",()=>{
  const input=snapshot(); input.ticket.state="acknowledged"; input.ticket.acknowledgedAt="2026-01-02T00:01:00.000Z";
  const initial=render(input); assert.equal(initial.title,"docklet hub: Ereignis");
  input.ticket.state="resolved"; input.ticket.resolvedAt="2026-01-02T00:02:00.000Z";
  const recovery=renderNotificationMessage(input,{ ...identity,phase:"recovery" });
  assert.equal(recovery.title,"docklet hub: Erholung"); assert.match(recovery.requiredText,/Erholung: Verbindung unterbrochen/u);
  assert.match(recovery.requiredText,/2026-01-02T00:02:00.000Z/u);
  const testMessage=renderNotificationMessage(input,{ ...identity,phase:"test" });
  assert.equal(testMessage.title,"docklet hub: Testnachricht"); assert.match(testMessage.requiredText,/Testnachricht am gespeicherten Kanal prüfen/u);
  for(const [event,action,label] of [
    ["self-healing-exhausted","inspect-self-healing","Selbstheilung prüfen"],
    ["update-failed","inspect-update","Update-Ergebnis"],
    ["agent-update-available","review-update","Verfügbares Update"]
  ] as const) {
    const next=snapshot(); Object.assign(next.ticket,{ event,action });
    if(event==="self-healing-exhausted") next.ticket.target={ kind:"stack",hostId:"host-a",projectName:"project-a" };
    assert.ok(render(next).requiredText.includes(label));
  }
});

test("literal substitution allows repetitions, never recursively evaluates ticket text or executes expressions",()=>{
  const input=snapshot(); input.ticket.cause="Literal {target} and <tag>";
  input.format="{target}|{target}|{cause}|{time}|{action}";
  input.options.additionalText="{cause} {action}";
  const message=render(input);
  assert.match(message.requiredText,/Synthetischer Host\|Synthetischer Host\|Literal \{target\} and <tag>/u);
  assert.match(message.optionalText!,/Literal \{target\} and <tag>/u);
  for(const format of ["{target} {cause} {time}","{target} {cause} {time} {action} {unknown}","{{target}} {cause} {time} {action}","{target.name} {cause} {time} {action}"]) {
    assert.throws(()=>render({ ...input,format }),{ message:"validation" });
  }
  assert.throws(()=>render({ ...input,options:{ ...input.options,additionalText:"{evil()}" } }),{ message:"validation" });
});

test("internal combined additional text accepts 2001 characters without write-option reparsing",()=>{
  const input=snapshot(); input.options.additionalText="a".repeat(1000)+"\n"+"b".repeat(1000);
  const message=render(input); assert.equal(message.optionalText,input.options.additionalText);
  assert.equal(message.optionalText!.length,2001);
  input.options.additionalText+="x"; assert.throws(()=>render(input),{ message:"validation" });
});

test("safe available logs require destination opt-in, unknown/unavailable evidence never supplies text",()=>{
  const input=snapshot(); input.ticket.evidence.logs={ state:"available",text:"Bereinigter Logauszug",truncated:true };
  assert.equal(render(input).optionalText,undefined);
  input.options.includeLogs=true; const message=render(input);
  assert.equal(message.optionalText,"Logs:\nBereinigter Logauszug\n[…]");
  for(const reason of ["not-collected","source-unavailable","redaction-unavailable"] as const) {
    input.ticket.evidence.logs={ state:"unavailable",reason }; assert.equal(render(input).optionalText,undefined);
  }
  input.ticket.evidence.logs={ state:"available",text:"x".repeat(4001),truncated:false };
  assert.throws(()=>render(input),{ message:"validation" });
  input.ticket.evidence.logs={ state:"unavailable",reason:"source-unavailable",text:"forbidden fallback" } as never;
  assert.throws(()=>render(input),{ message:"validation" });
});

function exactRequired(limit: number, channel: "webhook" | "discord") {
  const input=snapshot(); input.ticket.targetLabel="Target"; input.ticket.cause="C".repeat(1000);
  const minimal=renderNotificationMessage(input,{ ...identity,channel });
  const base=channel==="discord"?escaped(`${minimal.title}\n${minimal.requiredText}`).length:minimal.title.length+minimal.requiredText.length+2;
  // Each cause expansion is 1000 characters; literals fill the final remainder.
  const difference=limit-base;
  const repeats=Math.floor(difference/1000);
  input.format=DEFAULT_NOTIFICATION_FORMAT+"{cause}".repeat(repeats)+"x".repeat(difference-repeats*1000);
  assert.ok(input.format.length<=2000);
  return input;
}

test("8000-character combined limit accepts exact required content and rejects required +1",()=>{
  const input=exactRequired(8000,"webhook"); const message=render(input);
  assert.equal(message.title.length+message.requiredText.length+2,8000);
  input.format+="x"; assert.throws(()=>render(input),{ message:"validation" });
});

test("Discord escaped title plus required text accepts exactly 2000 and visibly rejects +1",()=>{
  const input=exactRequired(2000,"discord");
  const message=renderNotificationMessage(input,{ ...identity,channel:"discord" });
  assert.equal(escaped(`${message.title}\n${message.requiredText}`).length,2000);
  input.format+="x"; assert.throws(()=>renderNotificationMessage(input,{ ...identity,channel:"discord" }),{ message:"validation" });
  const punctuation=snapshot(); punctuation.ticket.cause="*_".repeat(500);
  assert.throws(()=>renderNotificationMessage(punctuation,{ ...identity,channel:"discord" }),{ message:"validation" });
});

test("optional text and sanitized logs truncate visibly, preserve required information and complete Unicode",()=>{
  const input=snapshot(); input.ticket.cause="C".repeat(1000);
  input.options.additionalText="{cause}".repeat(285); input.options.includeLogs=true;
  input.ticket.evidence.logs={ state:"available",text:"😀".repeat(2000),truncated:false };
  const message=render(input);
  assert.ok(message.title.length+message.requiredText.length+message.optionalText!.length+2<=8000);
  assert.ok(message.optionalText!.endsWith("\n[…]")); assert.ok(message.requiredText.includes(input.ticket.cause));
  assert.ok(!/[\uD800-\uDFFF]/u.test(message.optionalText!));
  const emoji=snapshot(); emoji.options.includeLogs=true; emoji.ticket.evidence.logs={ state:"available",text:"😀".repeat(2000),truncated:false };
  const discord=renderNotificationMessage(emoji,{ ...identity,channel:"discord" });
  assert.ok(discord.optionalText!.endsWith("\n[…]")); assert.ok(!/[\uD800-\uDFFF]/u.test(discord.optionalText!));
  assert.ok(escaped(`${discord.title}\n${discord.requiredText}\n${discord.optionalText}`).length<=2000);
});

test("growth from repeated required placeholders is rejected before output allocation; optional growth stays bounded",()=>{
  const input=snapshot(); input.ticket.cause="x".repeat(1000); input.format=DEFAULT_NOTIFICATION_FORMAT+"{cause}".repeat(280);
  assert.ok(input.format.length<=2000); assert.throws(()=>render(input),{ message:"validation" });
  input.format=DEFAULT_NOTIFICATION_FORMAT; input.options.additionalText="{cause}".repeat(285);
  const message=render(input); assert.ok(message.optionalText!.length<=8000); assert.ok(message.optionalText!.endsWith("\n[…]"));
});

test("controls and lone surrogates are rejected; idempotency keys are safe and stable by id and generation",()=>{
  for(const cause of ["unsafe\u0000text","unsafe\u0085text","unsafe\ud800text"]) {
    const input=snapshot(); input.ticket.cause=cause; assert.throws(()=>render(input),{ message:"validation" });
  }
  const input=snapshot(); input.options.additionalText="unsafe\u0000text"; assert.throws(()=>render(input),{ message:"validation" });
  const first=render(snapshot()); const second=render(snapshot()); assert.equal(first.idempotencyKey,second.idempotencyKey);
  const changed=renderNotificationMessage(snapshot(),{ ...identity,generation:1 }); assert.notEqual(first.idempotencyKey,changed.idempotencyKey);
  const oddId=renderNotificationMessage(snapshot(),{ ...identity,id:"id/with spaces ü and !" }); assert.match(oddId.idempotencyKey,/^[A-Za-z0-9._:-]{1,200}$/u);
  assert.ok(first.title.length<=NOTIFICATION_LIMITS.maxLabelChars);
});

test("optional expansion fits the combined exact boundary with a visible marker and fails when no marker can fit",()=>{
  const input=exactRequired(7996,"webhook"); input.options.additionalText="{cause}".repeat(285);
  const message=render(input); assert.equal(message.optionalText,"\n[…]");
  assert.equal(message.title.length+message.requiredText.length+message.optionalText!.length+2,8000);
  input.format+="x"; assert.throws(()=>render(input),{ message:"validation" });
});

function captureTransport(t: TestContext) {
  let payload: Record<string, unknown> | undefined;
  t.mock.method(https, "request", (_url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const request = new EventEmitter() as ClientRequest;
    request.destroy = () => request;
    request.end = (body?: unknown) => {
      payload = JSON.parse(String(body));
      const response = new EventEmitter() as IncomingMessage;
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", Buffer.from(JSON.stringify({ id: Object.hasOwn(options.headers ?? {}, "X-Gotify-Key") ? 1 : "1" })));
        response.emit("end");
      });
      return request;
    };
    return request;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(nodemailer, "createTransport", () => ({
    close: () => undefined,
    sendMail: async (mail: Record<string, unknown>) => {
      payload = mail;
      return { accepted: ["receiver@example.invalid"], rejected: [] };
    }
  }));
  const readPayload = () => payload;
  return async (channel: typeof NOTIFICATION_CHANNELS[number], message: NotificationMessage, markerFits = true) => {
    payload = undefined;
    const config: NotificationRuntimeConfig = channel === "smtp"
      ? { kind: "smtp", host: "example.invalid", port: 465, security: "tls", username: null, password: null,
        from: "hub@example.invalid", to: ["receiver@example.invalid"] }
      : channel === "gotify" ? { kind: "gotify", endpoint: "https://example.invalid", token: "synthetic-token" }
      : channel === "webhook" ? { kind: "webhook", endpoint: "https://example.invalid", authorization: null }
      : { kind: "discord", endpoint: "https://example.invalid" };
    assert.deepEqual(await sendNotification(config, message, new AbortController().signal), markerFits ? { status: "delivered" } : { status: "failed", failure: "validation" },
      `${channel}: ${message.title.length}/${message.requiredText.length}/${message.optionalText?.length ?? 0}`);
    const captured = readPayload();
    if (!markerFits) { assert.equal(captured, undefined); return ""; }
    assert.ok(captured);
    if (channel === "discord") assert.deepEqual(captured.allowed_mentions, { parse: [] });
    else assert.equal(channel === "smtp" ? captured.subject : captured.title, message.title);
    return String(channel === "discord" ? captured.content : channel === "gotify" ? captured.message : captured.text);
  };
}

function requiredBoundary(limit: number, channel: typeof NOTIFICATION_CHANNELS[number], phase: "initial" | "recovery" | "test") {
  const input = snapshot();
  input.ticket.targetLabel = "Target";
  input.ticket.cause = "C".repeat(1000);
  if (phase === "recovery") { input.ticket.state = "resolved"; input.ticket.resolvedAt = input.ticket.openedAt; }
  const message = renderNotificationMessage(input, { ...identity, channel, phase });
  const base = channel === "discord" ? escaped(`${message.title}\n${message.requiredText}`).length
    : message.title.length + message.requiredText.length + 2;
  const difference = limit - base;
  const causeSize = input.ticket.cause.length + (phase === "recovery" ? "Erholung: ".length : 0);
  input.format += "{cause}".repeat(Math.floor(difference / causeSize)) + "x".repeat(difference % causeSize);
  assert.ok(input.format.length <= 2000);
  return input;
}

test("fully fitting optional additions and logs stay byte-identical at every channel and phase boundary", { timeout: 3000 }, async (t) => {
  const transport = captureTransport(t);
  for (const channel of NOTIFICATION_CHANNELS) for (const phase of ["initial", "recovery", "test"] as const) {
    for (const mode of ["addition", "logs", "both"] as const) {
      for (const value of ["a", "ab", "abc", "abcd", "abcde", "abcdef", "x".repeat(100), "😀", "😀*_[]\\.!~"]) {
        const addition = mode === "logs" ? "" : value;
        const logs = mode === "addition" || phase === "test" ? "" : `Logs:\n${value}`;
        const expected = [addition, logs].filter(Boolean).join("\n");
        const size = channel === "discord" ? escaped(expected).length : expected.length;
        for (const spare of [0, 1]) {
          const limit = channel === "discord" ? 2000 : 8000;
          const input = requiredBoundary(limit - size - (expected ? 1 : 0) - spare, channel, phase);
          input.options.additionalText = addition;
          input.options.includeLogs = true;
          input.ticket.evidence.logs = { state: "available", text: value, truncated: false };
          let message!: NotificationMessage;
          assert.doesNotThrow(() => { message = renderNotificationMessage(input, { ...identity, channel, phase }); });
          assert.equal(message.optionalText ?? "", expected, `${channel}/${phase}/${mode}/${value}/${spare}`);
          const required = channel === "discord" ? escaped(`${message.title}\n${message.requiredText}`) : message.requiredText;
          const text = await transport(channel, message);
          assert.equal(text, required + (expected ? `\n${channel === "discord" ? escaped(expected) : expected}` : ""));
          assert.equal(channel === "discord" ? text.length : message.title.length + text.length + 2, limit - spare);
        }
      }
    }
  }
});

test("overlong optional content keeps a visible marker or fails when its escaped marker cannot fit", { timeout: 3000 }, async (t) => {
  const transport = captureTransport(t);
  for (const channel of NOTIFICATION_CHANNELS) for (const phase of ["initial", "recovery", "test"] as const) {
    for (const mode of ["addition", "logs", "both"] as const) for (const value of ["a", "ab", "abc", "abcd", "abcde", "abcdef", "x".repeat(100), "😀*_[]\\.!~"]) {
      const addition = mode === "logs" ? "" : value;
      const logs = mode === "addition" || phase === "test" ? "" : `Logs:\n${value}`;
      const expected = [addition, logs].filter(Boolean).join("\n");
      if (!expected) continue;
      const size = channel === "discord" ? escaped(expected).length : expected.length;
      const limit = channel === "discord" ? 2000 : 8000;
      const input = requiredBoundary(limit - size + 1 - (channel === "discord" ? 1 : 0), channel, phase);
      input.options.additionalText = addition;
      input.options.includeLogs = true;
      input.ticket.evidence.logs = { state: "available", text: value, truncated: false };
      const remaining = size - 1;
      if (remaining < (channel === "discord" ? escaped("\n[…]").length : "\n[…]".length)) {
        assert.throws(() => renderNotificationMessage(input, { ...identity, channel, phase }), { message: "validation" });
      } else {
        const message = renderNotificationMessage(input, { ...identity, channel, phase });
        assert.ok(message.optionalText!.endsWith("\n[…]"));
        assert.notEqual(message.optionalText, expected);
        const markerFits = channel === "discord" || message.requiredText.length + 1 + "\n[…]".length <= limit - message.title.length - 2;
        const text = await transport(channel, message, markerFits);
        assert.ok(channel === "discord" ? text.length <= limit : message.title.length + message.requiredText.length + message.optionalText!.length + 2 <= limit);
        if (markerFits) assert.ok(text.endsWith(channel === "discord" ? escaped("\n[…]") : "\n[…]"));
      }
    }
  }
});

test("Discord truncation reserves escaped marker space and searches complete Unicode prefixes", { timeout: 1000 }, async (t) => {
  const transport = captureTransport(t);
  for (const [value, budget, expected] of [["😀z", 7, "\n[…]"], ["😀z", 8, "😀\n[…]"],
    ["*".repeat(20), 8, "*\n[…]"], ["😀*_".repeat(20), 10, "😀*\n[…]"],
    ["😀".repeat(20), 7, "\n[…]"], ["abcde", 5, "abcde"]] as const) {
    const input = requiredBoundary(2000 - budget - 1, "discord", "initial");
    input.options.additionalText = value;
    // The short emoji fixtures must exceed the wire budget to exercise prefix search.
    if (value === "😀z") input.options.additionalText = value.repeat(10);
    let message!: NotificationMessage;
    assert.doesNotThrow(() => { message = renderNotificationMessage(input, { ...identity, channel: "discord" }); });
    assert.equal(message.optionalText, expected);
    assert.ok(!/[\uD800-\uDFFF]/u.test(message.optionalText!));
    assert.equal(await transport("discord", message), escaped(`${message.title}\n${message.requiredText}\n${expected}`));
  }
});

test("required transport budgets accept under and exact boundaries and reject overflow in all phases", { timeout: 1000 }, async (t) => {
  const transport = captureTransport(t);
  for (const channel of NOTIFICATION_CHANNELS) for (const phase of ["initial", "recovery", "test"] as const) {
    const limit = channel === "discord" ? 2000 : 8000;
    for (const spare of [0, 1]) {
      const input = requiredBoundary(limit - spare, channel, phase);
      const message = renderNotificationMessage(input, { ...identity, channel, phase });
      const text = await transport(channel, message);
      assert.equal(channel === "discord" ? text.length : message.title.length + text.length + 2, limit - spare);
      input.format += "x".repeat(spare + 1);
      assert.throws(() => renderNotificationMessage(input, { ...identity, channel, phase }), { message: "validation" });
    }
  }
});
