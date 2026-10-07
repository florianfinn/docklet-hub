import { generateKeyPairSync, sign } from "node:crypto";

function der(tag: number, ...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts);
  const length = value.length < 128 ? Buffer.from([value.length]) :
    Buffer.from(value.length <= 255 ? [0x81, value.length] : [0x82, value.length >> 8, value.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, value]);
}

// An ephemeral X.509 certificate avoids stored private keys and external TLS tools.
export function selfSignedTlsCredentials(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // sha256WithRSAEncryption, with the required NULL parameters.
  const algorithm = Buffer.from("300d06092a864886f70d01010b0500", "hex");
  const name = der(0x30, der(0x31, der(0x30,
    der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from("agent.invalid")))));
  const time = (at: number) => der(0x18, Buffer.from(new Date(at).toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z")));
  const now = Date.now();
  const certificateBody = der(0x30, der(0x02, Buffer.from([1])), algorithm, name,
    der(0x30, time(now - 86_400_000), time(now + 86_400_000)), name,
    publicKey.export({ type: "spki", format: "der" }));
  const certificate = der(0x30, certificateBody, algorithm,
    der(0x03, Buffer.from([0]), sign("sha256", certificateBody, privateKey)));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`
  };
}
