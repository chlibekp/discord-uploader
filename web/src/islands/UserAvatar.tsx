// Direct module import: the kit's index barrel pulls Motion into this island
// (~130 KB vs ~30 KB).
import { DitherAvatar } from "../components/dither-kit/avatar";

/** Fallback for Discord users with no avatar: deterministic per user id. */
export default function UserAvatar({ seed }: { seed: string }) {
  return <DitherAvatar name={seed} size={32} className="avatar" />;
}
