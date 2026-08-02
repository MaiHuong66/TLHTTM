import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchLecture } from "../../lib/api";
import { useToast } from "../../context/ToastContext";
import { LectureView } from "../../components/LectureView";
import { InlineSpinner } from "../../components/LoadingOverlay";
import type { Lecture } from "../../../shared/types";

export function TeacherLecturePage() {
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

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-slate-500 dark:text-slate-400">
        <InlineSpinner className="border-slate-300 border-t-slate-600 dark:border-slate-700 dark:border-t-slate-300" />
        Đang tải bài giảng...
      </div>
    );
  }

  if (!lecture) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center text-slate-500 dark:text-slate-400">
        Chưa có bài giảng nào. Hãy upload tài liệu ở cửa sổ "Upload tài liệu" trước.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <LectureView lecture={lecture} />
      <div className="text-center">
        <button
          type="button"
          onClick={() => navigate("/teacher/results")}
          className="rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white hover:bg-emerald-700 transition-colors"
        >
          HOÀN THÀNH BÀI HỌC
        </button>
      </div>
    </div>
  );
}
