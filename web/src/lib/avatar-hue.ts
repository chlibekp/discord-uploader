import { PALETTE, type Rgb } from "../components/dither-kit/palette";
import { fnv1a } from "../components/dither-kit/pixel";

/** HSL hue (0–360) of an RGB colour. */
function hueOf([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h =
    max === r
      ? ((g - b) / d) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

/** The mascot hues (indigo, cyan, gold) as DitherAvatar `hue` values. */
export const AVATAR_HUES: readonly number[] = [
  hueOf(PALETTE.indigo.fill),
  hueOf(PALETTE.cyan.fill),
  hueOf(PALETTE.gold.fill),
];

/**
 * Keeps the generated fallback avatar on the mascot palette: the same seed
 * always gets the same one of the three hues.
 */
export function avatarHue(seed: string): number {
  return AVATAR_HUES[fnv1a(seed) % AVATAR_HUES.length]!;
}
