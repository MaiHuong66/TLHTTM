import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTeacherAuth } from "../../context/TeacherAuthContext";
import { useToast } from "../../context/ToastContext";
import { ApiError, processUploadStep, startUpload } from "../../lib/api";
import { LoadingOverlay } from "../../components/LoadingOverlay";
import type { UploadFilePayload, UploadStepResponse } from "../../../shared/types";

const ACCEPTED_EXT = ".pdf,.docx,.xlsx,.png,.jpg,.jpeg";
const MAX_STEP_RETRIES = 6;

/**
 * Khi 1 bước bị lỗi tạm thời — Vercel ngắt hàm vì hết 60s (504), Gemini quá tải (503), mạng chập chờn —
 * job trong Redis vẫn còn nguyên trạng thái hợp lệ ở bước đó (kết quả chỉ được lưu khi bước thành công).
 * Vì vậy cách xử lý đúng là chờ rồi gọi lại ĐÚNG bước đó (cùng jobId), chờ lâu dần, thay vì coi cả lượt
 * upload (có thể đã chạy nhiều phút) là thất bại.
 */
async function processStepWithRetry(
  token: string,
  jobId: string,
  onRetry: (attempt: number, waitSec: number, rateLimited: boolean) => void
): Promise<UploadStepResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
    try {
      return await processUploadStep(token, jobId);
    } catch (err) {
      lastError = err;
      // 429 kèm retryAfterSec = vượt hạn mức theo phút: chờ đúng số giây Google yêu cầu rồi gọi lại bước này.
      const rateLimited = err instanceof ApiError && err.status === 429 && err.retryAfterSec !== undefined;
      const isRetryable = rateLimited || (err instanceof ApiError && (err.status === 0 || err.status >= 500));
      if (!isRetryable || attempt === MAX_STEP_RETRIES) throw err;
      const waitSec = rateLimited ? (err as ApiError).retryAfterSec! : Math.min(2 * (attempt + 1), 10);
      onRetry(attempt + 1, waitSec, rateLimited);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
    }
  }
  throw lastError;
}

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
  const [levelCounts, setLevelCounts] = useState<number[]>(DEFAULT_LEVEL_COUNTS);
  const [variantsPerCell, setVariantsPerCell] = useState(3);
  const [allowRetake, setAllowRetake] = useState(false);
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(15);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const examSize = levelCounts.reduce((a, b) => a + b, 0);
  const numTopics = Math.max(1, ...levelCounts);
  const { token } = useTeacherAuth();

  function setLevelCount(index: number, value: number) {
    const clamped = Math.min(20, Math.max(0, Math.floor(value) || 0));
    setLevelCounts((prev) => prev.map((v, i) => (i === index ? clamped : v)));
  }
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
    if (examSize === 0 || examSize > 60) {
      showToast("Tổng số câu của đề phải từ 1 đến 60.", "error");
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
        levelCounts,
        variantsPerCell,
        allowRetake,
        timeLimitMinutes,
      });

      let step: UploadStepResponse = { status: "processing", completedSteps: 0, totalSteps };
      while (step.status === "processing") {
        const progress = `(${step.completedSteps}/${step.totalSteps})`;
        setLoadingMessage(`AI đang tạo bài giảng và câu hỏi... ${progress}`);
        step = await processStepWithRetry(token, jobId, (n, waitSec, rateLimited) =>
          setLoadingMessage(
            rateLimited
              ? `AI đang giới hạn tần suất, chờ ${waitSec} giây rồi tự thử lại (lần ${n}/${MAX_STEP_RETRIES})... ${progress}`
              : `AI đang bận hoặc mạng chập chờn, tự thử lại bước này (lần ${n}/${MAX_STEP_RETRIES})... ${progress}`
          )
        );
      }

      if (step.status === "failed") {
        throw new Error(step.error || "Xử lý tài liệu thất bại.");
      }

      showToast(
        `Đã tạo bài giảng "${step.result?.title}", ngân hàng ${step.result?.questionCount} câu theo ` +
          `${step.result?.topicCount ?? "?"} chủ đề con; mỗi đề ${step.result?.examQuestionCount ?? "?"} câu. ` +
          `Website sẽ tự động cập nhật cho sinh viên.`,
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
          Dán nội dung hoặc tải lên tài liệu (PDF, DOCX, XLSX, PNG, JPG). Hệ thống sẽ tự động tạo bài giảng và đề
          trắc nghiệm theo cấu hình bên dưới, thay thế toàn bộ dữ liệu cũ.
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
            <h2 className="font-medium text-slate-800 dark:text-slate-200">Ma trận đề thi</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              AI chia tài liệu thành {numTopics} chủ đề con và lập ma trận (chủ đề con × mức độ), mỗi ô 1 câu trong đề với
              trọng tâm riêng, rồi soạn {variantsPerCell} câu dự phòng cho mỗi ô. Mỗi lượt làm bài bốc ngẫu nhiên 1 câu
              mỗi ô — tỉ lệ mức độ luôn cố định, không lặp nội dung — rồi đảo thứ tự câu và đáp án.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {LEVELS.map((level, i) => (
              <div key={level}>
                <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{level}</label>
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={levelCounts[i]}
                  onChange={(e) => setLevelCount(i, Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                Số câu dự phòng mỗi ô
              </label>
              <select
                value={variantsPerCell}
                onChange={(e) => setVariantsPerCell(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                <option value={2}>2 câu</option>
                <option value={3}>3 câu</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                Giới hạn thời gian làm bài (phút)
              </label>
              <input
                type="number"
                min={0}
                max={600}
                value={timeLimitMinutes}
                onChange={(e) => setTimeLimitMinutes(Math.max(0, Number(e.target.value) || 0))}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Tính từ lúc sinh viên bấm "Bắt đầu làm bài"; hết giờ hệ thống tự động nộp bài. Nhập 0 nếu không giới
                hạn.
              </p>
            </div>
          </div>

          <p className="text-sm text-slate-600 dark:text-slate-300">
            Mỗi đề: <strong>{examSize}</strong> câu ({LEVELS.map((l, i) => `${levelCounts[i]} ${l}`).join(", ")}) ·
            Ngân hàng: <strong>{examSize * variantsPerCell}</strong> câu ({examSize} ô × {variantsPerCell} câu dự phòng)
          </p>

          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={allowRetake}
              onChange={(e) => setAllowRetake(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-700"
            />
            Cho phép sinh viên làm bài nhiều lần (bỏ chọn = mỗi sinh viên chỉ được làm 1 lần)
          </label>
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

const LEVELS = ["Nhận biết", "Thông hiểu", "Vận dụng", "Vận dụng cao"];
/** Khớp DEFAULT_LEVEL_COUNTS ở server: 8 NB, 7 TH, 10 VD, 5 VDC = 30 câu. */
const DEFAULT_LEVEL_COUNTS = [8, 7, 10, 5];

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
