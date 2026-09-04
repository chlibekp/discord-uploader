import { describe, expect, it } from "vitest";
import { verifyInteractionSignature } from "../src/discord/verify.js";
import { publicKeyHex, sign } from "./helpers.js";

const body = Buffer.from(JSON.stringify({ type: 1 }));
const timestamp = "1735689600";

describe("verifyInteractionSignature", () => {
  it("accepts a valid signature", () => {
    expect(
      verifyInteractionSignature({
        publicKey: publicKeyHex,
        signature: sign(timestamp, body.toString()),
        timestamp,
        rawBody: body,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyInteractionSignature({
        publicKey: publicKeyHex,
        signature: sign(timestamp, body.toString()),
        timestamp,
        rawBody: Buffer.from(JSON.stringify({ type: 2 })),
      }),
    ).toBe(false);
  });

  it("rejects a different timestamp", () => {
    expect(
      verifyInteractionSignature({
        publicKey: publicKeyHex,
        signature: sign(timestamp, body.toString()),
        timestamp: "1735689601",
        rawBody: body,
      }),
    ).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(
      verifyInteractionSignature({
        publicKey: publicKeyHex,
        signature: null,
        timestamp,
        rawBody: body,
      }),
    ).toBe(false);
    expect(
      verifyInteractionSignature({
        publicKey: publicKeyHex,
        signature: sign(timestamp, body.toString()),
        timestamp: undefined,
        rawBody: body,
      }),
    ).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(
      verifyInteractionSignature({
        publicKey: publicKeyHex,
        signature: "not-hex",
        timestamp,
        rawBody: body,
      }),
    ).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    expect(
      verifyInteractionSignature({
        publicKey: publicKeyHex,
        signature: "ab".repeat(64),
        timestamp,
        rawBody: body,
      }),
    ).toBe(false);
  });
});
