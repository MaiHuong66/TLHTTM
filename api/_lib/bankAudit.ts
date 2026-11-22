import { cellsPerBatch } from "./gemini.js";
import type { AuditItem, RawQuestion } from "./gemini.js";
import type { UploadJob } from "./kv.js";

// Điều phối việc soạn + kiểm định ngân hàng câu hỏi trong 1 job upload (chỉ thao tác trên dữ liệu job, không gọi AI):
// mỗi câu có khóa tạm; bước "verify" loại câu sai/mơ hồ đáp án; bước "overlap" loại câu trùng ý với câu ở ô khác;
// ô thiếu câu được soạn lại (kèm danh sách ý phải tránh) rồi lại qua kiểm định. Cặp trùng không loại được thì ghi
// vào `job.conflicts` để lúc bốc đề không bao giờ bốc cả 2 câu vào cùng 1 đề.

/** Số lần tối đa soạn lại 1 ô (do thiếu câu, câu sai đáp án hoặc câu trùng ý). */
export const MAX_CELL_RETRIES = 3;
/** Số vòng rà trùng ý tối đa có kèm soạn lại; vòng cuối chỉ loại bớt câu dự phòng và ghi lại cặp trùng còn lại. */
export const MAX_OVERLAP_ROUNDS = 3;
/** Số câu kiểm tra đáp án trong 1 bước (1 lần gọi AI). */
export const VERIFY_BATCH = 30;
/** Giới hạn danh sách câu cần tránh đưa vào yêu cầu soạn lại (để yêu cầu không quá dài). */
const MAX_AVOID = 12;

/** Gắn khóa tạm cho các câu mới soạn của 1 ô. */
export function keyQuestions(job: UploadJob, cellId: string, questions: RawQuestion[]): RawQuestion[] {
  return questions.map((q) => (q.key ? q : { ...q, key: `${cellId}#${job.nextKey++}`, verified: false }));
}

/** Toàn bộ câu hiện có của ngân hàng (theo thứ tự ô của ma trận) ở dạng dùng cho các bước kiểm định. */
export function auditItems(job: UploadJob): AuditItem[] {
  const matrix = job.matrix;
  if (!matrix) return [];
  return matrix.cells.flatMap((cell) =>
    (job.questionsByCell[cell.id] ?? []).map((q) => ({
      key: q.key ?? "",
      cell: cell.id,
      topic: matrix.topics[cell.topic]?.name ?? "",
      level: cell.level,
      question: q.question,
      options: { A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD },
      correctAnswer: q.correctAnswer,
    }))
  );
}

function findQuestion(job: UploadJob, key: string): { cell: string; q: RawQuestion } | undefined {
  for (const [cell, list] of Object.entries(job.questionsByCell)) {
    const q = list.find((x) => x.key === key);
    if (q) return { cell, q };
  }
  return undefined;
}

function removeQuestion(job: UploadJob, key: string): void {
  for (const cell of Object.keys(job.questionsByCell)) {
    job.questionsByCell[cell] = job.questionsByCell[cell].filter((q) => q.key !== key);
  }
}

function addAvoid(job: UploadJob, cell: string, question: string): void {
  const list = job.avoidByCell[cell] ?? [];
  if (!list.includes(question)) job.avoidByCell[cell] = [...list, question].slice(-MAX_AVOID);
}

/** Các câu mà câu mới của ô KHÔNG được hỏi lại ý: câu hiện có ở ô khác cùng chủ đề + câu từng bị đánh dấu với ô. */
export function avoidListFor(job: UploadJob, cellId: string): string[] {
  const cell = job.matrix?.cells.find((c) => c.id === cellId);
  if (!cell || !job.matrix) return [];
  const siblings = job.matrix.cells
    .filter((c) => c.topic === cell.topic && c.id !== cellId)
    .flatMap((c) => (job.questionsByCell[c.id] ?? []).map((q) => q.question));
  return [...new Set([...(job.avoidByCell[cellId] ?? []), ...siblings])].slice(0, MAX_AVOID);
}

/**
 * Chèn các bước mới vào trước phần kiểm định ở cuối hàng đợi và bảo đảm sau chúng luôn còn 1 bước "verify" và 1 bước
 * "overlap" cuối cùng (câu mới soạn phải qua kiểm định). Không đụng tới bước đang chạy (job.steps[0]).
 */
export function queueWork(job: UploadJob, newSteps: string[]): void {
  const [current, ...rest] = job.steps;
  const before = rest.length;
  let idx = rest.findIndex((s) => s === "verify" || s === "overlap");
  if (idx < 0) idx = rest.length;
  rest.splice(idx, 0, ...newSteps);
  const after = idx + newSteps.length;
  if (!rest.slice(after).includes("verify")) rest.splice(after, 0, "verify");
  if (rest[rest.length - 1] !== "overlap") rest.push("overlap");
  job.steps = [current, ...rest];
  job.totalSteps += rest.length - before;
}

/** Cho soạn lại các ô (trong `onlyCells` nếu có) còn thiếu câu dự phòng và chưa hết lượt soạn lại. */
export function scheduleRefills(job: UploadJob, onlyCells?: string[]): string[] {
  const cells = job.matrix?.cells ?? [];
  const need = cells.filter(
    (c) =>
      (!onlyCells || onlyCells.includes(c.id)) &&
      (job.questionsByCell[c.id]?.length ?? 0) < job.variantsPerCell &&
      (job.cellRetries[c.id] ?? 0) < MAX_CELL_RETRIES
  );
  if (need.length === 0) return [];
  for (const c of need) job.cellRetries[c.id] = (job.cellRetries[c.id] ?? 0) + 1;

  const positions = need.map((c) => cells.indexOf(c));
  const batch = cellsPerBatch(job.variantsPerCell);
  const steps: string[] = [];
  for (let i = 0; i < positions.length; i += batch) steps.push(`q:${positions.slice(i, i + batch).join(",")}`);
  queueWork(job, steps);
  return need.map((c) => c.id);
}

/** Kết quả tự giải lại đáp án: giữ câu khớp đáp án; loại câu giải ra khác hoặc mơ hồ (ghi vào danh sách cần tránh
 * của ô để câu soạn lại không lặp lỗi). Câu AI không trả lời được thì vẫn giữ. Trả về các ô bị loại câu. */
export function applyAnswerChecks(
  job: UploadJob,
  checked: AuditItem[],
  results: Record<string, { answer?: string; ambiguous: boolean }>,
  log: (msg: string) => void = () => undefined
): string[] {
  const touched = new Set<string>();
  for (const item of checked) {
    const found = findQuestion(job, item.key);
    if (!found) continue;
    const r = results[item.key];
    if (r && (r.ambiguous || r.answer !== item.correctAnswer)) {
      log(
        `loại câu ${item.key} (${r.ambiguous ? "mơ hồ" : `đáp án gắn ${item.correctAnswer}, giải ra ${r.answer ?? "?"}`}): ${item.question.slice(0, 120)}`
      );
      removeQuestion(job, item.key);
      addAvoid(job, found.cell, item.question);
      touched.add(found.cell);
    } else {
      found.q.verified = true;
    }
  }
  return [...touched];
}

/**
 * Xử lý các cặp câu trùng ý (thuộc 2 ô khác nhau). Lần lượt loại câu dính nhiều cặp nhất trong số các câu mà ô của nó
 * còn câu dự phòng khác. Cặp mà cả 2 câu đều là câu cuối cùng của ô: nếu còn được soạn lại thì loại 1 câu (ô đó sẽ được
 * soạn lại, tránh ý của câu kia); nếu không thì ghi vào job.conflicts để lúc bốc đề tránh. Trả về các ô bị loại câu.
 */
export function applyOverlaps(
  job: UploadJob,
  pairs: [string, string][],
  allowRefill: boolean,
  log: (msg: string) => void = () => undefined
): string[] {
  const cellOf = new Map<string, string>();
  const textOf = new Map<string, string>();
  for (const [cell, list] of Object.entries(job.questionsByCell)) {
    for (const q of list) {
      if (!q.key) continue;
      cellOf.set(q.key, cell);
      textOf.set(q.key, q.question);
    }
  }
  const removed = new Set<string>();
  const touched = new Set<string>();
  const remainingInCell = (cell: string) =>
    (job.questionsByCell[cell] ?? []).filter((q) => q.key && !removed.has(q.key)).length;
  const remove = (key: string, partners: string[]) => {
    const cell = cellOf.get(key)!;
    removed.add(key);
    removeQuestion(job, key);
    for (const p of partners) addAvoid(job, cell, textOf.get(p) ?? "");
    touched.add(cell);
    log(`loại câu ${key} vì trùng ý với ${partners.join(", ")}: ${(textOf.get(key) ?? "").slice(0, 120)}`);
  };

  let active = pairs.filter(([a, b]) => cellOf.has(a) && cellOf.has(b) && cellOf.get(a) !== cellOf.get(b));
  for (let guard = 0; guard < 500; guard++) {
    active = active.filter(([a, b]) => !removed.has(a) && !removed.has(b));
    if (active.length === 0) break;

    const degree = new Map<string, number>();
    for (const [a, b] of active) {
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    const partnersOf = (key: string) => active.flatMap(([a, b]) => (a === key ? [b] : b === key ? [a] : []));

    const removable = [...degree.keys()].filter((k) => remainingInCell(cellOf.get(k)!) > 1);
    if (removable.length > 0) {
      const pick = removable.sort((x, y) => degree.get(y)! - degree.get(x)!)[0];
      remove(pick, partnersOf(pick));
      continue;
    }

    // Mọi cặp còn lại đều là câu cuối cùng của ô.
    const [a, b] = active[0];
    const canRefill = (k: string) => allowRefill && (job.cellRetries[cellOf.get(k)!] ?? 0) < MAX_CELL_RETRIES;
    const victim = canRefill(b) ? b : canRefill(a) ? a : null;
    if (victim) {
      remove(victim, partnersOf(victim));
    } else {
      // Không loại câu nào: ghi lại cặp để lúc bốc đề tránh, rồi xét các cặp còn lại.
      const id = [a, b].sort().join("|");
      if (!job.conflicts.some((c) => [...c].sort().join("|") === id)) job.conflicts.push([a, b]);
      log(`không soạn lại được nữa, ghi cặp trùng ${a} – ${b} để lúc bốc đề tránh`);
      active = active.slice(1);
    }
  }
  return [...touched];
}
