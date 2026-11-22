// Bốc đề theo ma trận (dùng chung cho /api/get-quiz và bước kiểm định lúc upload).

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Đề theo ma trận: mỗi ô (chủ đề con × mức độ) bốc ngẫu nhiên đúng 1 trong các câu dự phòng của ô — tỉ lệ mức độ luôn
 * cố định, mỗi lượt khác nhau — và không bao giờ bốc 2 câu nằm trong 1 cặp trùng ý (`conflicts`).
 *
 * Cách tìm: (1) loại trước các câu không thể dùng — câu trùng ý với MỌI câu còn lại của một ô khác (bốc nó thì ô kia
 * không còn câu nào); lặp tới khi không loại thêm được. (2) Thử-quay-lui ngẫu nhiên, mỗi bước bốc ô còn ít lựa chọn
 * nhất và chỉ nhận câu mà mọi ô chưa bốc vẫn còn câu hợp lệ. Nếu thật sự không có tổ hợp đủ mọi ô thì bỏ ô không bốc
 * được, vì đề không được có câu trùng nội dung.
 */
export function drawFromMatrix<T extends { id: string; cell?: string }>(
  questions: T[],
  matrixCells: string[],
  conflicts: [string, string][]
): T[] {
  const conflictsOf = new Map<string, Set<string>>();
  for (const [a, b] of conflicts) {
    conflictsOf.set(a, (conflictsOf.get(a) ?? new Set()).add(b));
    conflictsOf.set(b, (conflictsOf.get(b) ?? new Set()).add(a));
  }
  const clash = (a: T, b: T) => conflictsOf.get(a.id)?.has(b.id) ?? false;

  const pools = new Map<string, T[]>();
  for (const cell of matrixCells) {
    const pool = questions.filter((q) => q.cell === cell);
    if (pool.length > 0) pools.set(cell, pool);
  }

  // (1) Loại câu không thể dùng.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [cell, pool] of pools) {
      const usable = pool.filter((q) =>
        [...pools].every(([other, otherPool]) => other === cell || otherPool.some((o) => !clash(q, o)))
      );
      if (usable.length > 0 && usable.length < pool.length) {
        pools.set(cell, usable);
        changed = true;
      }
    }
  }

  // (2) Thử-quay-lui có kiểm tra trước.
  const chosen = new Map<string, T>();
  const options = (cell: string) =>
    pools.get(cell)!.filter((q) => [...chosen.values()].every((c) => !clash(q, c)));
  let budget = 50000;
  const search = (): boolean => {
    const remaining = [...pools.keys()].filter((c) => !chosen.has(c));
    if (remaining.length === 0) return true;
    // Ô ít lựa chọn nhất trước (hòa thì ngẫu nhiên).
    const cell = shuffle(remaining).sort((a, b) => options(a).length - options(b).length)[0];
    for (const q of shuffle(options(cell))) {
      if (--budget < 0) return false;
      chosen.set(cell, q);
      const stillPossible = remaining.every((c) => c === cell || options(c).length > 0);
      if (stillPossible && search()) return true;
      chosen.delete(cell);
    }
    return false;
  };
  if (search()) return [...chosen.values()];

  // Không có tổ hợp đủ mọi ô: chọn tham lam, bỏ ô không còn câu nào hợp lệ.
  chosen.clear();
  for (const cell of shuffle([...pools.keys()])) {
    const q = shuffle(options(cell))[0];
    if (q) chosen.set(cell, q);
  }
  return [...chosen.values()];
}

/** Các ô không thể có mặt trong đề nếu phải tránh mọi cặp trùng (rỗng = luôn bốc được đề đủ mọi ô). */
export function blockedCells<T extends { id: string; cell?: string }>(
  items: T[],
  matrixCells: string[],
  conflicts: [string, string][]
): string[] {
  const present = matrixCells.filter((c) => items.some((q) => q.cell === c));
  let best: Set<string> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const drawn = new Set(drawFromMatrix(items, matrixCells, conflicts).map((q) => q.cell ?? ""));
    if (!best || drawn.size > best.size) best = drawn;
    if (best.size === present.length) return [];
  }
  return present.filter((c) => !best!.has(c));
}
