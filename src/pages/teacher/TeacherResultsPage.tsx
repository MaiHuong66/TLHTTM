import { useEffect, useState } from "react";
import { fetchResults } from "../../lib/api";
import { useTeacherAuth } from "../../context/TeacherAuthContext";
import { useToast } from "../../context/ToastContext";
import { ResultsTable } from "../../components/ResultsTable";
import { InlineSpinner } from "../../components/LoadingOverlay";
import type { ResultRow } from "../../../shared/types";

export function TeacherResultsPage() {
  const [results, setResults] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { token } = useTeacherAuth();
  const { showToast } = useToast();

  useEffect(() => {
    if (!token) return;
    fetchResults(token)
      .then((res) => setResults(res.results))
      .catch((err) => showToast(err instanceof Error ? err.message : "Không thể tải kết quả.", "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white">KẾT QUẢ HỌC TẬP</h1>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-slate-500 dark:text-slate-400">
          <InlineSpinner className="border-slate-300 border-t-slate-600 dark:border-slate-700 dark:border-t-slate-300" />
          Đang tải kết quả...
        </div>
      ) : (
        <ResultsTable results={results} />
      )}
    </div>
  );
}
