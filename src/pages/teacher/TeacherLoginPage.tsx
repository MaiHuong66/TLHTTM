import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTeacherAuth } from "../../context/TeacherAuthContext";
import { useToast } from "../../context/ToastContext";
import { InlineSpinner } from "../../components/LoadingOverlay";

export function TeacherLoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useTeacherAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await login(username, password);
      showToast("Đăng nhập thành công!", "success");
      navigate("/teacher/upload");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Đăng nhập thất bại.", "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-sky-50 to-white dark:from-slate-950 dark:to-slate-900 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-lg space-y-4"
      >
        <div className="text-center space-y-1">
          <div className="text-3xl">🎓</div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Đăng nhập Giảng viên</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Trợ lý học tập</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Tên đăng nhập
            </label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Mật khẩu</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 py-2.5 font-medium text-white hover:bg-sky-700 disabled:opacity-50 transition-colors"
        >
          {loading && <InlineSpinner />}
          Đăng nhập
        </button>
      </form>
    </div>
  );
}
