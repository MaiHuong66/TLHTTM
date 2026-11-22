import { cellsPerBatch } from "./gemini.js";
import { blockedCells } from "./draw.js";
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
/** Số vòng rà trùng tối thiểu. Vòng sau chỉ chạy khi có câu được soạn lại (câu mới phải được rà), để tiết kiệm chi phí. */
export const MIN_OVERLAP_ROUNDS = 1;
/** Sau các vòng thường, còn tối đa tới vòng này để soạn lại các ô bị "kẹt" (không ghép được đề đủ ô). */
export const HARD_MAX_OVERLAP_ROUNDS = 5;
/** Số lần soạn lại thêm cho ô bị kẹt, ngoài MAX_CELL_RETRIES. */
const EXTRA_UNBLOCK_RETRIES = 2;
/** Số câu kiểm tra đáp án trong 1 bước (1 lần gọi AI). */
export const VERIFY_BATCH = 20;
/** Câu mà AI bỏ sót khi kiểm đáp án được gửi kiểm lại tối đa ngần này lần, sau đó giữ nguyên. */
export const MAX_VERIFY_TRIES = 2;
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
export function scheduleRefills(job: UploadJob, onlyCells?: string[], maxRetries = MAX_CELL_RETRIES): string[] {
  const cells = job.matrix?.cells ?? [];
  const need = cells.filter(
    (c) =>
      (!onlyCells || onlyCells.includes(c.id)) &&
      (job.questionsByCell[c.id]?.length ?? 0) < job.variantsPerCell &&
      (job.cellRetries[c.id] ?? 0) < maxRetries
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
 * của ô để câu soạn lại không lặp lỗi). Câu AI bỏ sót được kiểm lại ở lượt sau (tối đa MAX_VERIFY_TRIES lần). Trả
 * về các ô bị loại câu. */
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
    if (!r) {
      // AI bỏ sót câu này: để lượt kiểm sau gửi lại; quá MAX_VERIFY_TRIES lần thì giữ nguyên.
      found.q.verifyTries = (found.q.verifyTries ?? 0) + 1;
      if (found.q.verifyTries >= MAX_VERIFY_TRIES) found.q.verified = true;
      continue;
    }
    // Chỉ loại khi AI giải ra đáp án KHÁC đáp án đã gắn. Cờ "mơ hồ" của AI không đủ tin cậy (thử thật: đánh dấu mơ hồ cả
    // những câu nó giải ra đúng đáp án và có trong tài liệu) nên chỉ ghi log, không loại.
    if (r.answer !== item.correctAnswer) {
      log(`loại câu ${item.key} (đáp án gắn ${item.correctAnswer}, giải ra ${r.answer ?? "?"}): ${item.question.slice(0, 120)}`);
      removeQuestion(job, item.key);
      addAvoid(job, found.cell, item.question);
      touched.add(found.cell);
    } else {
      if (r.ambiguous) log(`câu ${item.key} được đánh dấu có thể mơ hồ (vẫn giữ): ${item.question.slice(0, 120)}`);
      found.q.verified = true;
    }
  }
  return [...touched];
}

/**
 * Xử lý các cặp câu trùng ý (thuộc 2 ô khác nhau). Lần lượt loại câu dính nhiều cặp nhất trong số các câu mà ô của nó
 * còn câu dự phòng khác. Cặp mà cả 2 câu đều là câu cuối cùng của ô: nếu còn được soạn lại thì loại 1 câu (ô đó sẽ được
 * soạn lại, tránh ý của câu kia); nếu không thì ghi vào job.conflicts để lúc bốc đề tránh. Ở vòng cuối
 * (`allowRefill` = false) không loại câu nào mà chỉ ghi lại mọi cặp. Trả về các ô bị loại câu.
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

  // Vòng cuối (không còn được soạn lại): KHÔNG loại câu nào, chỉ ghi lại cặp trùng để lúc bốc đề tránh. Loại câu ở vòng
  // này chỉ làm ô còn ít câu dự phòng — 2 ô chỉ còn 1 câu mà 2 câu đó trùng nhau thì đề nào cũng phải bỏ 1 ô.
  if (!allowRefill) {
    for (const [a, b] of active) {
      const id = [a, b].sort().join("|");
      if (!job.conflicts.some((c) => [...c].sort().join("|") === id)) job.conflicts.push([a, b]);
      log(`ghi cặp trùng ${a} – ${b} để lúc bốc đề tránh`);
    }
    return [];
  }

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

/**
 * Sau khi đã ghi lại các cặp trùng: nếu không thể bốc đề đủ mọi ô mà không dính cặp trùng (vd mọi câu dự phòng của 1 ô
 * đều trùng ý với mọi câu của 1 ô khác — 2 ô vốn hỏi cùng một ý), thì loại các câu dính cặp trùng của ô bị kẹt và cho
 * soạn lại ô đó, tránh ý của các câu đối diện. Trả về các ô được cho soạn lại.
 */
export function unblockCells(job: UploadJob, log: (msg: string) => void = () => undefined): string[] {
  if (!job.matrix) return [];
  const items = auditItems(job).map((i) => ({ id: i.key, cell: i.cell }));
  const blocked = blockedCells(items, job.matrix.cells.map((c) => c.id), job.conflicts);
  if (blocked.length === 0) return [];

  const textOf = new Map(auditItems(job).map((i) => [i.key, i.question]));
  const refill: string[] = [];
  for (const cell of blocked) {
    if ((job.cellRetries[cell] ?? 0) >= MAX_CELL_RETRIES + EXTRA_UNBLOCK_RETRIES) continue;
    const keys = (job.questionsByCell[cell] ?? []).map((q) => q.key ?? "");
    const conflicted = keys.filter((k) => job.conflicts.some(([a, b]) => a === k || b === k));
    for (const key of conflicted) {
      for (const [a, b] of job.conflicts) {
        const partner = a === key ? b : b === key ? a : null;
        if (partner) addAvoid(job, cell, textOf.get(partner) ?? "");
      }
      removeQuestion(job, key);
    }
    job.conflicts = job.conflicts.filter(([a, b]) => !conflicted.includes(a) && !conflicted.includes(b));
    log(`ô ${cell} bị kẹt (mọi câu đều trùng ý với ô khác): loại ${conflicted.length} câu, soạn lại với trọng tâm khác`);
    refill.push(cell);
  }
  return scheduleRefills(job, refill, MAX_CELL_RETRIES + EXTRA_UNBLOCK_RETRIES);
}
