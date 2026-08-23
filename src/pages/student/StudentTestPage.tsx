import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, fetchQuiz, submitTest } from "../../lib/api";
import { useToast } from "../../context/ToastContext";
import { LoadingOverlay } from "../../components/LoadingOverlay";
import { DarkModeToggle } from "../../components/DarkModeToggle";
import type { AnswerKey, QuizQuestion, SubmitTestResponse } from "../../../shared/types";

type Step = "form" | "quiz" | "result" | "blocked";

const OPTION_KEYS: AnswerKey[] = ["A", "B", "C", "D"];

const DIFFICULTY_STYLES: Record<string, string> = {
  "Cơ bản": "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  "Trung bình": "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  "Nâng cao": "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
};

export function StudentTestPage() {
  const [step, setStep] = useState<Step>("form");
  const [hoTen, setHoTen] = useState("");
  const [lop, setLop] = useState("");
  const [quiz, setQuiz] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, AnswerKey>>({});
  const [result, setResult] = useState<SubmitTestResponse | null>(null);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const { showToast } = useToast();

  async function handleStart(e: FormEvent) {
    e.preventDefault();
    if (!hoTen.trim() || !lop.trim()) return;

    setLoadingMessage("Đang tạo đề bài test ngẫu nhiên...");
    try {
      const res = await fetchQuiz();
      setQuiz(res.questions);
      setAnswers({});
      setStep("quiz");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Không thể tải đề bài test.", "error");
    } finally {
      setLoadingMessage(null);
    }
  }

  function selectAnswer(questionId: string, option: AnswerKey) {
    setAnswers((prev) => ({ ...prev, [questionId]: option }));
  }

  const answeredCount = Object.keys(answers).length;
  const allAnswered = quiz.length > 0 && answeredCount === quiz.length;

  async function handleSubmit() {
    setLoadingMessage("Đang chấm điểm và tạo nhận xét...");
    try {
      const res = await submitTest(
        hoTen.trim(),
        lop.trim(),
        quiz.map((q) => q.id),
        answers
      );
      setResult(res);
      setStep("result");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStep("blocked");
      } else {
        showToast(err instanceof Error ? err.message : "Nộp bài thất bại.", "error");
      }
    } finally {
      setLoadingMessage(null);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {loadingMessage && <LoadingOverlay message={loadingMessage} />}

      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
            📝 <span>Bài test</span>
          </div>
          <DarkModeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        {step === "form" && (
          <form
            onSubmit={handleStart}
            className="mx-auto max-w-sm space-y-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-sm"
          >
            <h1 className="text-center text-xl font-bold text-slate-900 dark:text-white">
              Thông tin sinh viên
            </h1>
            <p className="text-center text-sm text-slate-500 dark:text-slate-400">
              Mỗi sinh viên chỉ được làm bài test 1 lần duy nhất.
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Họ tên</label>
              <input
                value={hoTen}
                onChange={(e) => setHoTen(e.target.value)}
                required
                autoFocus
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Lớp</label>
              <input
                value={lop}
                onChange={(e) => setLop(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded-lg bg-sky-600 py-2.5 font-semibold text-white hover:bg-sky-700 transition-colors"
            >
              Bắt đầu làm bài
            </button>
          </form>
        )}

        {step === "quiz" && (
          <div className="space-y-5">
            <div className="sticky top-0 z-10 -mx-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50/95 dark:bg-slate-950/95 px-4 py-3 backdrop-blur">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-600 dark:text-slate-300">
                  Đã trả lời {answeredCount}/{quiz.length} câu
                </span>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!allAnswered}
                  className="rounded-lg bg-emerald-600 px-5 py-2 font-semibold text-white hover:bg-emerald-700 disabled:opacity-40 transition-colors"
                >
                  NỘP BÀI
                </button>
              </div>
            </div>

            {quiz.map((q, idx) => (
              <div
                key={q.id}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4"
              >
                <div className="mb-3 flex items-start justify-between gap-2">
                  <p className="font-medium text-slate-900 dark:text-white">
                    Câu {idx + 1}. {q.question}
                  </p>
                  {q.difficulty && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${DIFFICULTY_STYLES[q.difficulty] ?? ""}`}
                    >
                      {q.difficulty}
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {OPTION_KEYS.map((key) => (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        answers[q.id] === key
                          ? "border-sky-500 bg-sky-50 dark:bg-sky-950/40"
                          : "border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                      }`}
                    >
                      <input
                        type="radio"
                        name={q.id}
                        checked={answers[q.id] === key}
                        onChange={() => selectAnswer(q.id, key)}
                        className="mt-0.5"
                      />
                      <span>
                        <strong>{key}.</strong> {q.options[key]}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {step === "result" && result && (
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 text-center space-y-2">
              <p className="text-sm text-slate-500 dark:text-slate-400">Điểm số của bạn</p>
              <p className="text-4xl font-bold text-sky-600 dark:text-sky-400">
                {result.score}/{result.total}
              </p>
              <p className="mx-auto max-w-md text-slate-700 dark:text-slate-200">{result.danhGia}</p>
            </div>

            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Đáp án chi tiết</h2>
              {result.review.map((item, idx) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4"
                >
                  <p className="mb-2 font-medium text-slate-900 dark:text-white">
                    Câu {idx + 1}. {item.question}
                  </p>
                  <div className="space-y-1 text-sm">
                    {OPTION_KEYS.map((key) => {
                      const isCorrectOption = key === item.correctAnswer;
                      const isChosenWrong = key === item.chosen && !item.isCorrect;
                      return (
                        <div
                          key={key}
                          className={`rounded-lg px-3 py-1.5 ${
                            isCorrectOption
                              ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300"
                              : isChosenWrong
                                ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
                                : "text-slate-600 dark:text-slate-300"
                          }`}
                        >
                          <strong>{key}.</strong> {item.options[key]}
                          {isCorrectOption && " ✓"}
                          {isChosenWrong && " (bạn chọn)"}
                        </div>
                      );
                    })}
                    {!item.chosen && <p className="text-xs italic text-slate-400">Bạn chưa chọn đáp án nào.</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === "blocked" && (
          <div className="mx-auto max-w-sm rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-6 text-center space-y-2">
            <div className="text-3xl">⚠️</div>
            <h1 className="text-lg font-bold text-amber-800 dark:text-amber-300">Bạn đã làm bài test này rồi</h1>
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Mỗi sinh viên chỉ được làm bài kiểm tra 1 lần duy nhất.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
