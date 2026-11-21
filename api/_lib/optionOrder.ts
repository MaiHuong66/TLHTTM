import type { AnswerKey, Question, QuizReviewItem } from "../../shared/types.js";

export const ANSWER_KEYS: AnswerKey[] = ["A", "B", "C", "D"];

/** Thứ tự đáp án ngẫu nhiên cho 1 câu: phần tử thứ i là đáp án GỐC sẽ hiển thị ở vị trí i (A, B, C, D). */
export function randomOptionOrder(): AnswerKey[] {
  const order = [...ANSWER_KEYS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function isValidOrder(order: AnswerKey[] | undefined): order is AnswerKey[] {
  return Array.isArray(order) && order.length === 4 && ANSWER_KEYS.every((k) => order.includes(k));
}

/** Các phương án theo thứ tự hiển thị của lượt làm. */
export function displayedOptions(question: Question, order: AnswerKey[] | undefined): Record<AnswerKey, string> {
  if (!isValidOrder(order)) return question.options;
  return {
    A: question.options[order[0]],
    B: question.options[order[1]],
    C: question.options[order[2]],
    D: question.options[order[3]],
  };
}

/** Đáp án sinh viên chọn (theo vị trí hiển thị) -> đáp án gốc của câu hỏi. */
export function toOriginalKey(displayed: AnswerKey, order: AnswerKey[] | undefined): AnswerKey {
  if (!isValidOrder(order)) return displayed;
  return order[ANSWER_KEYS.indexOf(displayed)];
}

/** Đáp án gốc -> vị trí hiển thị trong lượt làm. */
export function toDisplayedKey(original: AnswerKey, order: AnswerKey[] | undefined): AnswerKey {
  if (!isValidOrder(order)) return original;
  return ANSWER_KEYS[order.indexOf(original)];
}

/** Chấm 1 lượt làm theo đúng danh sách câu server đã giao. `answers` là đáp án sinh viên chọn theo vị trí HIỂN THỊ
 * (đã đảo); phần xem lại trả về cũng theo thứ tự hiển thị đó để khớp với những gì sinh viên đã thấy. */
export function gradeAttempt(
  questionIds: string[],
  bankById: Map<string, Question>,
  optionOrders: Record<string, AnswerKey[]> | undefined,
  answers: Record<string, unknown>
): { score: number; review: QuizReviewItem[] } {
  let score = 0;
  const review: QuizReviewItem[] = [];
  for (const id of questionIds) {
    const question = bankById.get(id);
    if (!question) continue;
    const order = optionOrders?.[id];
    const raw = answers[id];
    const chosen = ANSWER_KEYS.includes(raw as AnswerKey) ? (raw as AnswerKey) : null;
    const isCorrect = chosen !== null && toOriginalKey(chosen, order) === question.correctAnswer;
    if (isCorrect) score++;
    review.push({
      id: question.id,
      question: question.question,
      options: displayedOptions(question, order),
      correctAnswer: toDisplayedKey(question.correctAnswer, order),
      chosen,
      isCorrect,
    });
  }
  return { score, review };
}
