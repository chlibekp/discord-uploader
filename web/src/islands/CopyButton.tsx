import { useState, type MouseEvent } from "react";
import { toast } from "../lib/toast";

export default function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  async function click(e: MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access is refused outside a secure context or without focus.
      toast(`Copy failed. Link: ${text}`, "error", 8000);
    }
  }
  return (
    <button
      type="button"
      className={`button small${copied ? " copied" : ""}`}
      onClick={click}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
