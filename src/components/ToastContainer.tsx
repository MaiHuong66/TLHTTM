import { useToast } from "../context/ToastContext";

const STYLES: Record<string, string> = {
  success: "bg-emerald-600 text-white",
  error: "bg-red-600 text-white",
  info: "bg-slate-800 text-white dark:bg-slate-700",
};

const ICONS: Record<string, string> = {
  success: "✓",
  error: "✕",
  info: "ℹ",
};

export function ToastContainer() {
  const { toasts, dismissToast } = useToast();

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismissToast(t.id)}
          className={`${STYLES[t.type]} rounded-lg shadow-lg px-4 py-3 text-sm flex items-start gap-2 cursor-pointer`}
        >
          <span className="font-bold">{ICONS[t.type]}</span>
          <span className="flex-1">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
