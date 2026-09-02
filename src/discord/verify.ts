import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/** DER prefix that turns a raw 32-byte Ed25519 key into an SPKI document. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const keyCache = new Map<string, ReturnType<typeof createPublicKey>>();

function publicKeyFor(hexKey: string) {
  const cached = keyCache.get(hexKey);
  if (cached) return cached;

  const raw = Buffer.from(hexKey, "hex");
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");

  const key = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
  keyCache.set(hexKey, key);
  return key;
}

/**
 * Verify a Discord interaction signature over `timestamp + rawBody`.
 *
 * Must run against the exact bytes Discord sent, before any JSON parsing, since
 * re-serialising the body would change the signed message.
 */
export function verifyInteractionSignature(args: {
  publicKey: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  rawBody: Buffer;
}): boolean {
  const { publicKey, signature, timestamp, rawBody } = args;
  if (!signature || !timestamp) return false;
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) return false;

  try {
    const message = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
    return cryptoVerify(null, message, publicKeyFor(publicKey), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}
