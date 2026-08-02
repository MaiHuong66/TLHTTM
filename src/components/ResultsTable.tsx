import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import type { ResultRow } from "../../shared/types";

type SortKey = keyof ResultRow;
type SortDirection = "asc" | "desc";

function parseScoreRatio(diem: string): number {
  const [correct, total] = diem.split("/").map(Number);
  if (!total) return 0;
  return correct / total;
}

export function ResultsTable({ results }: { results: ResultRow[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("stt");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? results.filter((r) => r.hoTen.toLowerCase().includes(q) || r.lop.toLowerCase().includes(q))
      : results;

    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "diem") {
        cmp = parseScoreRatio(a.diem) - parseScoreRatio(b.diem);
      } else if (sortKey === "stt") {
        cmp = a.stt - b.stt;
      } else {
        cmp = String(a[sortKey]).localeCompare(String(b[sortKey]), "vi");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [results, search, sortKey, sortDir]);

  const stats = useMemo(() => {
    if (results.length === 0) return null;
    const ratios = results.map((r) => parseScoreRatio(r.diem));
    const avg = (ratios.reduce((s, v) => s + v, 0) / ratios.length) * 100;
    const best = Math.max(...ratios) * 100;
    return { count: results.length, avg: avg.toFixed(1), best: best.toFixed(0) };
  }, [results]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function handleExport() {
    const sheetData = filtered.map((r) => ({
      STT: r.stt,
      "Họ tên": r.hoTen,
      Lớp: r.lop,
      Điểm: r.diem,
      "Đánh giá": r.danhGia,
      "Thời gian nộp": r.thoiGianNop,
    }));
    const worksheet = XLSX.utils.json_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "KetQuaHocTap");
    XLSX.writeFile(workbook, "ket-qua-hoc-tap.xlsx");
  }

  const columns: { key: SortKey; label: string }[] = [
    { key: "stt", label: "STT" },
    { key: "hoTen", label: "Họ tên" },
    { key: "lop", label: "Lớp" },
    { key: "diem", label: "Điểm" },
    { key: "danhGia", label: "Đánh giá" },
    { key: "thoiGianNop", label: "Thời gian nộp" },
  ];

  return (
    <div className="space-y-4">
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Lượt nộp bài" value={String(stats.count)} />
          <StatCard label="Điểm TB" value={`${stats.avg}%`} />
          <StatCard label="Điểm cao nhất" value={`${stats.best}%`} />
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm theo họ tên hoặc lớp..."
          className="w-full sm:max-w-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
        />
        <button
          type="button"
          onClick={handleExport}
          disabled={filtered.length === 0}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40 transition-colors"
        >
          Tải Excel
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className="cursor-pointer select-none px-3 py-2 text-left font-semibold whitespace-nowrap"
                >
                  {col.label} {sortKey === col.key ? (sortDir === "asc" ? "▲" : "▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-slate-400">
                  Chưa có dữ liệu kết quả học tập.
                </td>
              </tr>
            ) : (
              filtered.map((r, i) => (
                <tr
                  key={`${r.hoTen}-${r.lop}-${i}`}
                  className="border-t border-slate-200 dark:border-slate-700 odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800/50"
                >
                  <td className="px-3 py-2">{r.stt}</td>
                  <td className="px-3 py-2">{r.hoTen}</td>
                  <td className="px-3 py-2">{r.lop}</td>
                  <td className="px-3 py-2 font-medium">{r.diem}</td>
                  <td className="px-3 py-2 max-w-xs">{r.danhGia}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.thoiGianNop}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-center">
      <div className="text-xl font-bold text-sky-600 dark:text-sky-400">{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  );
}
