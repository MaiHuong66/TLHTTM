import type { Lecture } from "../../shared/types";

export function LectureView({ lecture }: { lecture: Lecture }) {
  return (
    <article className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">{lecture.title}</h1>
        <p className="text-xs text-slate-400">
          Cập nhật lần cuối: {new Date(lecture.updatedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}
        </p>
      </header>

      {lecture.sections.map((section, i) => (
        <section
          key={i}
          className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3"
        >
          <h2 className="text-lg font-semibold text-sky-700 dark:text-sky-400">{section.heading}</h2>
          <p className="whitespace-pre-wrap leading-relaxed text-slate-700 dark:text-slate-200">
            {section.content}
          </p>

          {section.examples.length > 0 && (
            <div className="rounded-lg bg-sky-50 dark:bg-sky-950/40 border border-sky-100 dark:border-sky-900 p-3">
              <p className="mb-1 text-sm font-semibold text-sky-800 dark:text-sky-300">Ví dụ minh họa</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
                {section.examples.map((ex, j) => (
                  <li key={j}>{ex}</li>
                ))}
              </ul>
            </div>
          )}

          {section.notes.length > 0 && (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900 p-3">
              <p className="mb-1 text-sm font-semibold text-amber-800 dark:text-amber-300">Lưu ý</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
                {section.notes.map((note, j) => (
                  <li key={j}>{note}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}

      <section className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-5">
        <h2 className="mb-2 text-lg font-semibold text-emerald-800 dark:text-emerald-300">Tóm tắt</h2>
        <p className="whitespace-pre-wrap leading-relaxed text-slate-700 dark:text-slate-200">{lecture.summary}</p>
      </section>
    </article>
  );
}
