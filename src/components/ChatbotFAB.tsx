import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { sendChatMessage } from "../lib/api";
import { useToast } from "../context/ToastContext";
import { InlineSpinner } from "./LoadingOverlay";
import type { ChatMessage } from "../../shared/types";

export function ChatbotFAB() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const nextHistory: ChatMessage[] = [...messages, { role: "user", text }];
    setMessages(nextHistory);
    setInput("");
    setLoading(true);

    try {
      const { reply } = await sendChatMessage(nextHistory);
      setMessages((prev) => [...prev, { role: "model", text: reply }]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Không thể kết nối chatbot.", "error");
      setMessages(messages);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-4 z-[80] flex h-[70vh] max-h-[520px] w-[calc(100%-2rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl">
          <div className="flex items-center justify-between bg-sky-600 px-4 py-3 text-white">
            <span className="font-semibold">Trợ lý học tập</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Đóng chatbot"
              className="rounded-full p-1 hover:bg-white/20"
            >
              ✕
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50 dark:bg-slate-950">
            {messages.length === 0 && (
              <p className="text-sm text-slate-500 dark:text-slate-400 text-center mt-6 px-4">
                Hỏi bất kỳ điều gì về nội dung bài giảng nhé!
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-sky-600 text-white rounded-br-sm"
                      : "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-bl-sm"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="rounded-xl rounded-bl-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                  Đang suy nghĩ...
                </div>
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-slate-200 dark:border-slate-700 p-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Nhập câu hỏi..."
              className="flex-1 rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-600 text-white disabled:opacity-40"
              aria-label="Gửi"
            >
              {loading ? <InlineSpinner /> : "➤"}
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Đóng chatbot" : "Mở chatbot"}
        className="fixed bottom-4 right-4 z-[80] flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg hover:bg-sky-700 transition-colors text-2xl"
      >
        {open ? "✕" : "💬"}
      </button>
    </>
  );
}
