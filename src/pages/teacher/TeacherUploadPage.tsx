import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTeacherAuth } from "../../context/TeacherAuthContext";
import { useToast } from "../../context/ToastContext";
import { processUploadStep, startUpload } from "../../lib/api";
import { LoadingOverlay } from "../../components/LoadingOverlay";
import type { UploadFilePayload, UploadStepResponse } from "../../../shared/types";

const ACCEPTED_EXT = ".pdf,.docx,.xlsx,.png,.jpg,.jpeg";

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.slice(result.indexOf(",") + 1);
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Không thể đọc file "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

export function TeacherUploadPage() {
  const [pastedText, setPastedText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [numChapters, setNumChapters] = useState(1);
  const [totalBankQuestions, setTotalBankQuestions] = useState(100);
  const [questionsPerChapterInExam, setQuestionsPerChapterInExam] = useState(60);
  const [fixedExam, setFixedExam] = useState(false);
  const [allowRetake, setAllowRetake] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const { token } = useTeacherAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    setFiles((prev) => [...prev, ...selected]);
    e.target.value = "";
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;

    if (!pastedText.trim() && files.length === 0) {
      showToast("Vui lòng dán nội dung hoặc chọn ít nhất 1 file.", "error");
      return;
    }

    setLoadingMessage("Đang tải tài liệu lên...");
    try {
      const payloadFiles: UploadFilePayload[] = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          mimeType: f.type || guessMimeType(f.name),
          base64: await readFileAsBase64(f),
        }))
      );

      const { jobId, totalSteps } = await startUpload(token, pastedText, payloadFiles, {
        numChapters,
        totalBankQuestions,
        questionsPerChapterInExam,
        fixedExam,
        allowRetake,
      });

      let step: UploadStepResponse = { status: "processing", completedSteps: 0, totalSteps };
      while (step.status === "processing") {
        setLoadingMessage(
          `AI đang tạo bài giảng và ngân hàng câu hỏi... (${step.completedSteps}/${step.totalSteps})`
        );
        step = await processUploadStep(token, jobId);
      }

      if (step.status === "failed") {
        throw new Error(step.error || "Xử lý tài liệu thất bại.");
      }

      showToast(
        `Đã tạo bài giảng "${step.result?.title}" với ${step.result?.questionCount} câu hỏi. Website sẽ tự động cập nhật cho sinh viên.`,
        "success"
      );
      navigate("/teacher/lecture");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gửi tài liệu thất bại.", "error");
    } finally {
      setLoadingMessage(null);
    }
  }

  return (
    <div className="space-y-6">
      {loadingMessage && <LoadingOverlay message={loadingMessage} />}

      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Upload tài liệu</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Dán nội dung hoặc tải lên tài liệu (PDF, DOCX, XLSX, PNG, JPG). Hệ thống sẽ tự động tạo bài giảng và ngân
          hàng câu hỏi trắc nghiệm theo cấu hình bên dưới, thay thế toàn bộ dữ liệu cũ.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Nội dung tài liệu (dán trực tiếp)
          </label>
          <textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            rows={8}
            placeholder="Dán nội dung tài liệu vào đây..."
            className="w-full resize-y rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Hoặc tải lên file (có thể chọn nhiều file)
          </label>
          <input
            type="file"
            multiple
            accept={ACCEPTED_EXT}
            onChange={handleFileChange}
            className="block w-full text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-sky-600 file:px-4 file:py-2 file:text-white file:font-medium hover:file:bg-sky-700 file:cursor-pointer cursor-pointer"
          />
          {files.length > 0 && (
            <ul className="mt-3 space-y-1">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                >
                  <span className="truncate text-slate-700 dark:text-slate-200">
                    {f.name} <span className="text-slate-400">({(f.size / 1024).toFixed(0)} KB)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="ml-2 shrink-0 text-red-500 hover:text-red-700 font-medium"
                  >
                    Xóa
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 space-y-3">
          <div>
            <h2 className="font-medium text-slate-800 dark:text-slate-200">Cấu hình ngân hàng câu hỏi & đề thi</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Nếu tài liệu có nhiều chương/phần được đánh dấu rõ ràng (ví dụ "Chương 1", "Chương 2"...), nhập số
              chương để AI sinh câu hỏi riêng theo từng chương và đề thi lấy đều số câu mỗi chương. Để "Số chương" =
              1 nếu tài liệu không chia chương.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Số chương</label>
              <input
                type="number"
                min={1}
                max={20}
                value={numChapters}
                onChange={(e) => setNumChapters(Math.max(1, Number(e.target.value) || 1))}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                Tổng số câu hỏi ngân hàng
              </label>
              <input
                type="number"
                min={numChapters}
                max={500}
                value={totalBankQuestions}
                onChange={(e) => setTotalBankQuestions(Math.max(1, Number(e.target.value) || 1))}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                Số câu {numChapters > 1 ? "mỗi chương " : ""}trong đề thi
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={questionsPerChapterInExam}
                disabled={fixedExam}
                onChange={(e) => setQuestionsPerChapterInExam(Math.max(1, Number(e.target.value) || 1))}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50"
              />
            </div>
          </div>

          <p className="text-sm text-slate-500 dark:text-slate-400">
            {fixedExam ? (
              <>
                Đề thi cố định: <strong>{totalBankQuestions}</strong> câu ({numChapters} chương × ~
                {Math.ceil(totalBankQuestions / numChapters)} câu/chương) — dùng toàn bộ ngân hàng, mọi lượt làm
                bài đều giống nhau.
              </>
            ) : (
              <>
                Tổng số câu trong 1 đề thi (random): <strong>{numChapters * questionsPerChapterInExam}</strong> câu
                ({numChapters} chương × {questionsPerChapterInExam} câu/chương)
              </>
            )}
          </p>

          <div className="flex flex-col sm:flex-row gap-3 pt-1">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={fixedExam}
                onChange={(e) => setFixedExam(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700"
              />
              Đề thi cố định (không random, dùng toàn bộ ngân hàng, giống nhau mỗi lượt làm)
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={allowRetake}
                onChange={(e) => setAllowRetake(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700"
              />
              Cho phép sinh viên làm bài nhiều lần
            </label>
          </div>
        </div>

        <button
          type="submit"
          disabled={!!loadingMessage}
          className="w-full sm:w-auto rounded-lg bg-sky-600 px-6 py-3 font-semibold text-white hover:bg-sky-700 disabled:opacity-50 transition-colors"
        >
          GỬI TÀI LIỆU
        </button>
      </form>
    </div>
  );
}

function guessMimeType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
