import { createContext, useContext } from "react";
import { formatRemaining } from "../../../public/gallery-filters.js";
import { useNow } from "../lib/state";

/**
 * The time the server rendered the page. While set, countdowns read it instead
 * of the live clock, so the hydrating render prints exactly what the server
 * did. FilesView clears it once mounted and the shared clock takes over.
 */
export const RenderedAt = createContext<number | null>(null);

export default function Expiry({ at }: { at: number }) {
  const frozen = useContext(RenderedAt);
  const now = useNow();
  return <>{formatRemaining(at, frozen ?? now)}</>;
}
