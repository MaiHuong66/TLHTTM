import { Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTeacherAuth } from "../../context/TeacherAuthContext";
import { DarkModeToggle } from "../../components/DarkModeToggle";

const TABS = [
  { to: "/teacher/upload", label: "1. Upload tài liệu" },
  { to: "/teacher/lecture", label: "2. Bài giảng" },
  { to: "/teacher/results", label: "3. Kết quả học tập" },
];

export function TeacherLayout() {
  const { token, logout } = useTeacherAuth();
  const navigate = useNavigate();

  if (!token) {
    return <Navigate to="/teacher/login" replace />;
  }

  function handleLogout() {
    logout();
    navigate("/");
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
            🎓 <span>Giảng viên</span>
          </div>
          <nav className="flex flex-wrap gap-1">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-sky-600 text-white"
                      : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <DarkModeToggle />
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Đăng xuất
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
