import { describe, expect, it } from "vitest";
import { AVATAR_HUES, avatarHue } from "../web/src/lib/avatar-hue";

describe("avatarHue", () => {
  it("is the HSL hue of the indigo, cyan and gold palette fills", () => {
    expect(AVATAR_HUES).toEqual([243, 197, 47]);
  });

  it("gives the same id the same hue", () => {
    expect(avatarHue("123456789012345678")).toBe(
      avatarHue("123456789012345678"),
    );
  });

  it("only ever picks a palette hue, and uses all three", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const hue = avatarHue(String(100000000000000000n + BigInt(i)));
      expect(AVATAR_HUES).toContain(hue);
      seen.add(hue);
    }
    expect(seen.size).toBe(3);
  });
});
