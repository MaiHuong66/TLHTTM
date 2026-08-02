import { Link } from "react-router-dom";
import { DarkModeToggle } from "../components/DarkModeToggle";

export function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-white to-sky-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex flex-col">
      <header className="flex justify-end px-4 py-4">
        <DarkModeToggle />
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 pb-16 text-center">
        <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 dark:text-white mb-2">Trợ lý học tập</h1>
        <p className="text-slate-500 dark:text-slate-400 mb-10 max-w-md">
          Hệ thống học tập thông minh: bài giảng, chatbot và bài kiểm tra được tạo tự động bằng AI.
        </p>

        <div className="grid gap-6 sm:grid-cols-2 w-full max-w-2xl">
          <Link
            to="/teacher/login"
            className="group rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-8 shadow-sm hover:shadow-lg hover:border-sky-400 transition-all"
          >
            <div className="text-5xl mb-4">🎓</div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1 group-hover:text-sky-600 transition-colors">
              Giảng viên
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Upload tài liệu, tạo bài giảng, quản lý kết quả học tập
            </p>
          </Link>

          <Link
            to="/student"
            className="group rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-8 shadow-sm hover:shadow-lg hover:border-sky-400 transition-all"
          >
            <div className="text-5xl mb-4">📘</div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-1 group-hover:text-sky-600 transition-colors">
              Sinh viên
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Xem bài giảng, hỏi chatbot và làm bài kiểm tra
            </p>
          </Link>
        </div>
      </main>
    </div>
  );
}
