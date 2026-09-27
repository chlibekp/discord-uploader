import { useEffect, useRef, useState, type MouseEvent } from "react";
import { announce } from "../lib/toast";

const ARM_EVENT = "dash:arm";

/**
 * Deleting is irreversible, so the first click only arms. It disarms after 4s,
 * or as soon as another ArmButton arms, matching the legacy gallery.
 */
export default function ArmButton({
  describe,
  onConfirm,
  label = "Delete",
  armedLabel = "Delete?",
}: {
  describe: string;
  onConfirm: () => Promise<void> | void;
  label?: string;
  armedLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const me = useRef(Symbol());

  useEffect(() => {
    const onArm = (e: Event) => {
      if ((e as CustomEvent).detail !== me.current) setArmed(false);
    };
    window.addEventListener(ARM_EVENT, onArm);
    return () => {
      window.removeEventListener(ARM_EVENT, onArm);
      clearTimeout(timer.current);
    };
  }, []);

  async function click(e: MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    if (!armed) {
      window.dispatchEvent(new CustomEvent(ARM_EVENT, { detail: me.current }));
      setArmed(true);
      announce(
        `Press ${label.toLowerCase()} again to remove ${describe}. This cannot be undone.`,
      );
      timer.current = window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(timer.current);
    setArmed(false);
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`button small danger${armed ? " armed" : ""}`}
      onClick={click}
      disabled={busy}
    >
      {busy ? "…" : armed ? armedLabel : label}
    </button>
  );
}
