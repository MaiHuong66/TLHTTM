import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchLecture } from "../../lib/api";
import { useToast } from "../../context/ToastContext";
import { LectureView } from "../../components/LectureView";
import { ChatbotFAB } from "../../components/ChatbotFAB";
import { DarkModeToggle } from "../../components/DarkModeToggle";
import { InlineSpinner } from "../../components/LoadingOverlay";
import type { Lecture } from "../../../shared/types";

export function StudentLecturePage() {
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    fetchLecture()
      .then((res) => setLecture(res.lecture))
      .catch((err) => showToast(err instanceof Error ? err.message : "Không thể tải bài giảng.", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
            📘 <span>Sinh viên</span>
          </div>
          <DarkModeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-slate-500 dark:text-slate-400">
            <InlineSpinner className="border-slate-300 border-t-slate-600 dark:border-slate-700 dark:border-t-slate-300" />
            Đang tải bài giảng...
          </div>
        ) : !lecture ? (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center text-slate-500 dark:text-slate-400">
            Chưa có bài giảng nào được tạo. Vui lòng quay lại sau khi giảng viên upload tài liệu.
          </div>
        ) : (
          <>
            <LectureView lecture={lecture} />
            <div className="text-center">
              <button
                type="button"
                onClick={() => navigate("/student/test")}
                className="rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white hover:bg-emerald-700 transition-colors"
              >
                HOÀN THÀNH BÀI HỌC
              </button>
            </div>
          </>
        )}
      </main>

      {lecture && <ChatbotFAB />}
    </div>
  );
}
