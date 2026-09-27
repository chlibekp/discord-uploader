import { announceStore, toastStore } from "../lib/toast";
import { useStore } from "../lib/store";

export default function Toasts() {
  const toasts = useStore(toastStore);
  const said = useStore(announceStore);
  return (
    <>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast panel ${t.kind}`}>
            <div className="toast-in">{t.message}</div>
          </div>
        ))}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {said}
      </div>
    </>
  );
}
