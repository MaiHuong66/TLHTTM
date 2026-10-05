import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, fetchExamInfo, startQuiz, submitTest } from "../../lib/api";
import { useToast } from "../../context/ToastContext";
import { LoadingOverlay } from "../../components/LoadingOverlay";
import { DarkModeToggle } from "../../components/DarkModeToggle";
import type { AnswerKey, ExamInfo, QuizQuestion, SubmitTestResponse } from "../../../shared/types";

type Step = "form" | "quiz" | "result" | "blocked";

const OPTION_KEYS: AnswerKey[] = ["A", "B", "C", "D"];
const AUTO_SUBMIT_RETRIES = 3;
const ANSWERS_STORAGE_PREFIX = "tlhttm-answers-";

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function loadSavedAnswers(attemptId: string): Record<string, AnswerKey> {
  try {
    const raw = localStorage.getItem(ANSWERS_STORAGE_PREFIX + attemptId);
    return raw ? (JSON.parse(raw) as Record<string, AnswerKey>) : {};
  } catch {
    return {};
  }
}

function saveAnswers(attemptId: string, answers: Record<string, AnswerKey>) {
  try {
    localStorage.setItem(ANSWERS_STORAGE_PREFIX + attemptId, JSON.stringify(answers));
  } catch {
    // Bộ nhớ trình duyệt bị chặn/đầy: bỏ qua, chỉ mất khả năng khôi phục đáp án khi tải lại trang.
  }
}

function clearSavedAnswers(attemptId: string) {
  try {
    localStorage.removeItem(ANSWERS_STORAGE_PREFIX + attemptId);
  } catch {
    // bỏ qua
  }
}

export function StudentTestPage() {
  const [step, setStep] = useState<Step>("form");
  const [hoTen, setHoTen] = useState("");
  const [lop, setLop] = useState("");
  const [quiz, setQuiz] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, AnswerKey>>({});
  const [result, setResult] = useState<SubmitTestResponse | null>(null);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [examInfo, setExamInfo] = useState<ExamInfo | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<{ title: string; message: string } | null>(null);
  const { showToast } = useToast();

  const submittingRef = useRef(false);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  useEffect(() => {
    fetchExamInfo()
      .then(setExamInfo)
      .catch(() => setExamInfo({ fixedExam: false, allowRetake: false, timeLimitMinutes: 0 }));
  }, []);

  async function handleStart(e: FormEvent) {
    e.preventDefault();
    if (!hoTen.trim() || !lop.trim()) return;

    setLoadingMessage(examInfo?.fixedExam ? "Đang tải đề bài test..." : "Đang tạo đề bài test ngẫu nhiên...");
    try {
      const res = await startQuiz(hoTen.trim(), lop.trim());
      setQuiz(res.questions);
      setAttemptId(res.attemptId);
      setAnswers(res.resumed ? loadSavedAnswers(res.attemptId) : {});
      if (res.timeLimitSeconds > 0) {
        setDeadline(Date.now() + res.remainingSeconds * 1000);
        setRemaining(res.remainingSeconds);
      } else {
        setDeadline(null);
        setRemaining(null);
      }
      if (res.resumed) {
        showToast(
          res.timeLimitSeconds > 0
            ? `Bạn đang tiếp tục lượt làm bài trước đó. Thời gian còn lại: ${formatTime(res.remainingSeconds)}.`
            : "Bạn đang tiếp tục lượt làm bài trước đó.",
          "info"
        );
      }
      setStep("quiz");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setBlocked({ title: "Bạn không thể bắt đầu làm bài", message: err.message });
        setStep("blocked");
      } else {
        showToast(err instanceof Error ? err.message : "Không thể tải đề bài test.", "error");
      }
    } finally {
      setLoadingMessage(null);
    }
  }

  function selectAnswer(questionId: string, option: AnswerKey) {
    setAnswers((prev) => {
      const next = { ...prev, [questionId]: option };
      if (attemptId) saveAnswers(attemptId, next);
      return next;
    });
  }

  const answeredCount = Object.keys(answers).length;
  const timed = deadline !== null;
  // Đề có giới hạn thời gian cho phép nộp sớm khi chưa trả lời hết (sẽ hỏi xác nhận); đề không giới hạn vẫn
  // yêu cầu trả lời đủ như trước.
  const canSubmit = quiz.length > 0 && (timed || answeredCount === quiz.length);

  const submit = useCallback(
    async (auto: boolean) => {
      if (!attemptId || submittingRef.current) return;
      submittingRef.current = true;
      setLoadingMessage(auto ? "Hết giờ! Đang tự động nộp bài..." : "Đang chấm điểm và tạo nhận xét...");
      try {
        let res: SubmitTestResponse | null = null;
        for (let attempt = 0; attempt <= (auto ? AUTO_SUBMIT_RETRIES : 0); attempt++) {
          try {
            res = await submitTest(attemptId, answersRef.current);
            break;
          } catch (err) {
            const retryable = err instanceof ApiError && (err.status === 0 || err.status >= 500);
            if (!auto || !retryable || attempt === AUTO_SUBMIT_RETRIES) throw err;
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        }
        if (res) {
          clearSavedAnswers(attemptId);
          setResult(res);
          setStep("result");
        }
      } catch (err) {
        if (err instanceof ApiError && (err.status === 409 || err.status === 403)) {
          setBlocked({
            title: err.status === 403 ? "Đã quá thời gian làm bài" : "Không thể nộp bài",
            message: err.message,
          });
          setStep("blocked");
        } else {
          showToast(err instanceof Error ? err.message : "Nộp bài thất bại.", "error");
        }
      } finally {
        submittingRef.current = false;
        setLoadingMessage(null);
      }
    },
    [attemptId, showToast]
  );

  const submitRef = useRef(submit);
  submitRef.current = submit;

  // Đồng hồ đếm ngược: dựa trên hạn chót tính từ thời gian còn lại do server trả về lúc bắt đầu.
  useEffect(() => {
    if (step !== "quiz" || deadline === null) return;

    const tick = () => {
      const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(secondsLeft);
      if (secondsLeft === 0) {
        window.clearInterval(timer);
        showToast("Đã hết thời gian làm bài, hệ thống đang tự động nộp bài.", "info");
        void submitRef.current(true);
      }
    };
    const timer = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(timer);
  }, [step, deadline, showToast]);

  function handleManualSubmit() {
    const unanswered = quiz.length - answeredCount;
    if (unanswered > 0 && timed) {
      const ok = window.confirm(`Bạn còn ${unanswered} câu chưa trả lời. Vẫn nộp bài? (Câu chưa trả lời sẽ tính là sai)`);
      if (!ok) return;
    }
    void submit(false);
  }

  const timerClass =
    remaining === null
      ? ""
      : remaining <= 60
        ? "text-red-600 dark:text-red-400 animate-pulse"
        : remaining <= 300
          ? "text-amber-600 dark:text-amber-400"
          : "text-emerald-600 dark:text-emerald-400";

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
              {examInfo?.allowRetake
                ? "Bạn có thể làm bài test nhiều lần."
                : "Mỗi sinh viên chỉ được làm bài test 1 lần duy nhất."}
            </p>
            {!!examInfo?.timeLimitMinutes && (
              <p className="rounded-lg bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-center text-sm text-amber-800 dark:text-amber-300">
                ⏱ Thời gian làm bài: <strong>{examInfo.timeLimitMinutes} phút</strong>, tính từ lúc bạn bấm "Bắt đầu
                làm bài". Hết giờ hệ thống sẽ tự động nộp bài.
              </p>
            )}
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
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:gap-4">
                  {remaining !== null && (
                    <span className={`text-lg font-bold tabular-nums ${timerClass}`}>⏱ {formatTime(remaining)}</span>
                  )}
                  <span className="text-sm font-medium text-slate-600 dark:text-slate-300">
                    Đã trả lời {answeredCount}/{quiz.length} câu
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleManualSubmit}
                  disabled={!canSubmit}
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
                <p className="mb-3 font-medium text-slate-900 dark:text-white">
                  Câu {idx + 1}. {q.question}
                </p>
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
            <h1 className="text-lg font-bold text-amber-800 dark:text-amber-300">
              {blocked?.title ?? "Bạn đã làm bài test này rồi"}
            </h1>
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {blocked?.message ?? "Mỗi sinh viên chỉ được làm bài kiểm tra 1 lần duy nhất."}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
