import type { AnswerKey, Question } from "../../shared/types.js";

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
