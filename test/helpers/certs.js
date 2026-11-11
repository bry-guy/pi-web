// Test only: throwaway X.509 certificates (EC P-256, signed by a throwaway CA) built with node:crypto,
// since neither the sandbox nor CI promises an `openssl` binary.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

const len = n => n < 128 ? Buffer.from([n]) : (b => Buffer.concat([Buffer.from([0x80 | b.length]), b]))(Buffer.from(n.toString(16).padStart(n > 255 ? 4 : 2, "0"), "hex"));
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const oid = s => {
  const [a, b, ...rest] = s.split(".").map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) { const out = [n & 0x7f]; for (let v = n >> 7; v; v >>= 7) out.unshift(0x80 | (v & 0x7f)); bytes.push(...out); }
  return tlv(0x06, Buffer.from(bytes));
};
const name = cn => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const time = d => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

// { cert, key } as PEM. issuer: { cert, key } of the CA, or none for a self-signed CA. ip: a SAN.
export function makeCert({ cn, issuer = null, ca = false, ip = null }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exts = [ext("2.5.29.19", true, ca ? seq(tlv(0x01, Buffer.from([0xff]))) : seq())];
  if (ca) exts.push(ext("2.5.29.15", true, tlv(0x03, Buffer.from([0x01, 0x06])))); // keyCertSign, cRLSign
  if (ip) exts.push(ext("2.5.29.17", false, seq(tlv(0x87, Buffer.from(ip.split(".").map(Number))))));
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.concat([Buffer.from([1]), randomBytes(8)])),
    ECDSA_SHA256,
    name(issuer ? new X509Certificate(issuer.cert).subject.replace(/^CN=/, "") : cn),
    seq(time(new Date(now - 3_600_000)), time(new Date(now + 86_400_000))),
    name(cn),
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(...exts)),
  );
  const signer = issuer ? createPrivateKey(issuer.key) : privateKey;
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sign("sha256", tbs, signer)));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}
