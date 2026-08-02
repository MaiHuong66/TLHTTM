export function LoadingOverlay({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-4 bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm">
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-sky-200 border-t-sky-600 dark:border-slate-700 dark:border-t-sky-400" />
      <p className="text-slate-700 dark:text-slate-200 font-medium text-center px-6">{message}</p>
    </div>
  );
}

export function InlineSpinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white ${className}`}
    />
  );
}
