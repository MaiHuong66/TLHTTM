/** Chuẩn hóa Họ tên + Lớp để so khớp "cùng 1 sinh viên": bỏ khác biệt hoa/thường, khoảng trắng thừa và
 * dạng mã hóa Unicode của chữ có dấu (cùng 1 tên gõ bằng 2 bộ gõ có thể khác nhau ở mức byte). */
export function normalizeStudentKey(hoTen: string, lop: string): string {
  const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return `${norm(hoTen)}|${norm(lop)}`;
}
