# Trợ lý học tập

Hệ thống học tập thông minh dùng Gemini API: giảng viên upload tài liệu, AI tự động tạo bài giảng và ngân hàng ~100 câu hỏi trắc nghiệm; sinh viên xem bài giảng, hỏi chatbot, làm bài kiểm tra 60 câu ngẫu nhiên và nhận kết quả/nhận xét tự động.

## Công nghệ

- React 19 + TypeScript + Vite, Tailwind CSS v4
- Vercel Serverless Functions (thư mục `api/`) — nơi duy nhất gọi Gemini API và các API khác, API key không bao giờ lộ ra frontend
- Gemini API (`@google/genai`, model `gemini-2.5-flash`) — đọc tài liệu, tạo bài giảng, sinh câu hỏi, chatbot, chấm điểm/nhận xét
- Upstash Redis (REST) — lưu **Bài giảng** + **Ngân hàng câu hỏi** (dữ liệu đọc nhiều bởi mọi sinh viên)
- Google Sheets API (`googleapis`) — lưu bảng **Kết quả học tập** (giảng viên xem/tìm kiếm/tải Excel)

## Cấu trúc thư mục

```
api/                  # Vercel Serverless Functions
  _lib/                # helper dùng chung: gemini.ts, sheets.ts, kv.ts, fileParsers.ts, auth.ts, http.ts
  teacher-login.ts
  upload-document.ts
  get-lecture.ts
  get-quiz.ts
  submit-test.ts
  chat.ts
  get-results.ts
shared/types.ts        # type dùng chung giữa api/ và src/
src/
  pages/                # HomePage, teacher/*, student/*
  components/           # LectureView, ChatbotFAB, ResultsTable, Toast, ...
  context/              # Theme, Toast, TeacherAuth
  lib/api.ts            # fetch wrapper gọi các API
```

## Thiết lập môi trường (bắt buộc trước khi chạy)

Ứng dụng cần 3 dịch vụ bên ngoài. Không có key nào được hardcode — tất cả đọc từ Environment Variables.

### 1. Gemini API key

1. Truy cập https://aistudio.google.com/apikey, đăng nhập bằng tài khoản Google.
2. Tạo API key mới, copy lại.
3. Gán vào biến `GEMINI_API_KEY`.

### 2. Google Sheets (Service Account) — cho bảng Kết quả học tập

1. Vào https://console.cloud.google.com/, tạo một Project mới (hoặc dùng project có sẵn).
2. Vào **APIs & Services > Library**, tìm **Google Sheets API**, bấm **Enable**.
3. Vào **APIs & Services > Credentials > Create Credentials > Service account**. Đặt tên bất kỳ, bấm **Done**.
4. Mở Service Account vừa tạo > tab **Keys** > **Add Key > Create new key > JSON**. File JSON tải về chứa `client_email` và `private_key`.
5. Gán:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` = giá trị `client_email` trong file JSON.
   - `GOOGLE_PRIVATE_KEY` = giá trị `private_key` (giữ nguyên các ký tự `\n`, dán trong dấu ngoặc kép nếu paste vào Vercel dashboard).
6. Tạo một Google Sheet mới (trống) tại https://sheets.google.com. Bấm **Share**, thêm email ở bước 5 (`GOOGLE_SERVICE_ACCOUNT_EMAIL`) với quyền **Editor**.
7. Lấy `GOOGLE_SHEET_ID` từ URL của Sheet: `https://docs.google.com/spreadsheets/d/<GOOGLE_SHEET_ID>/edit`.

Mỗi lần giảng viên upload tài liệu mới thành công, hệ thống tự động tạo **1 sheet (tab) kết quả mới** trong cùng Spreadsheet (tên dạng `KQ <ngày giờ> - <tên bài giảng>`) để lưu kết quả riêng cho bài giảng đó — các sheet kết quả của những lần upload trước vẫn được giữ nguyên làm lưu trữ, không bị xóa. Trang "Kết quả học tập" trên web và việc chống làm-lại-bài-test chỉ áp dụng cho sheet mới nhất (bài giảng hiện hành). Không cần tạo sheet nào bằng tay.

### 3. Upstash Redis — cho Bài giảng + Ngân hàng câu hỏi

Cách nhanh nhất: trong Vercel Dashboard của project, vào tab **Storage > Marketplace Database Integrations**, chọn **Upstash for Redis**, tạo database miễn phí (gói Free, 500.000 lệnh/tháng). Vercel sẽ tự thêm các biến `KV_REST_API_URL` và `KV_REST_API_TOKEN` vào project (đặt theo chuẩn tên Vercel KV cũ, code đã hỗ trợ sẵn).

Hoặc tạo thủ công tại https://console.upstash.com > **Create database** > copy `UPSTASH_REDIS_REST_URL` và `UPSTASH_REDIS_REST_TOKEN` trong tab **REST API** (code cũng hỗ trợ cặp tên này).

### 4. Tài khoản Giảng viên

Mặc định: `giangvien` / `giangvien` (đúng theo yêu cầu). Có thể đổi qua `TEACHER_USERNAME` / `TEACHER_PASSWORD`.

## Chạy thử ở local

```bash
npm install
npx vercel login
npx vercel link
npx vercel env pull .env.local
npx vercel dev
```

`vercel dev` chạy cả frontend (Vite) lẫn các Serverless Functions trong `api/` trên cùng 1 cổng — cần dùng lệnh này thay vì `npm run dev` để test được đầy đủ luồng (upload tài liệu, chatbot, làm bài test...). Lệnh `vercel env pull` tự tải các biến môi trường bạn đã cấu hình trên Vercel dashboard về `.env.local` (không commit file này).

## Deploy lên Vercel

1. Push code lên GitHub/GitLab/Bitbucket, import repo vào https://vercel.com/new (Vercel tự nhận diện Vite + thư mục `api/`, không cần cấu hình build thêm).
2. Vào **Settings > Environment Variables** của project, khai báo đầy đủ các biến ở mục Thiết lập môi trường phía trên (cho cả Production và Preview).
3. Deploy. Mọi sinh viên chỉ cần truy cập đường link Vercel cấp — không cần đăng nhập.

## Giới hạn cần lưu ý

- Vercel Serverless Functions giới hạn dung lượng request khoảng 4.5MB — ứng dụng tự chặn và báo lỗi rõ ràng nếu tổng dung lượng file vượt 4MB (giảng viên nên chia nhỏ tài liệu quá lớn thành nhiều lần upload, lưu ý mỗi lần upload sẽ thay thế hoàn toàn bài giảng + ngân hàng câu hỏi cũ).
- File PDF/ảnh được upload lên Gemini Files API đúng 1 lần (`api/_lib/gemini.ts#uploadFilesToGemini`) rồi tái sử dụng tham chiếu (`fileUri`) cho các lệnh gọi sau, thay vì gửi lại base64 nhiều lần — tránh crash do quá tải bộ nhớ khi xử lý file lớn.
- Việc tạo bài giảng + câu hỏi được chia thành nhiều bước độc lập (`api/upload-document.ts` khởi tạo job, `api/upload-step.ts` xử lý từng bước): 1 bước bài giảng, N bước **trích xuất riêng nội dung từng chương** (`extractChapterContent`), rồi mới tới các lô sinh câu hỏi. Lý do: mỗi lô câu hỏi nếu đọc lại toàn bộ tài liệu gốc mỗi lần sẽ rất chậm khi tài liệu nhiều chương — tách nội dung từng chương ra text thuần đúng 1 lần giúp các lô câu hỏi sau đó chỉ cần đọc đoạn text nhỏ, nhanh và an toàn hơn nhiều so với trần 60s. Trạng thái job được lưu tạm trong Redis (TTL 15 phút) để client gọi lặp lại `upload-step` cho tới khi xong; nếu 1 bước bị Vercel ngắt do hết 60s, client tự động thử lại đúng bước đó (job không bị hỏng vì tiến trình bị giết trước khi kịp lưu lỗi).
- Nếu sinh viên truy cập khi giảng viên chưa upload tài liệu nào, hệ thống sẽ hiển thị thông báo rõ ràng thay vì lỗi.
- Ngân hàng câu hỏi được sinh theo nhiều lô nhỏ (≤10 câu/lô) rồi lọc trùng — tổng số câu cuối cùng có thể thấp hơn một chút so với con số cấu hình tùy nội dung tài liệu. Mỗi lô mới được nhắc kèm danh sách câu đã sinh trước đó trong cùng chương để tránh trùng lặp/diễn đạt lại.
- **Cấu hình theo chương**: ở trang Upload, giảng viên có thể khai báo "Số chương", "Tổng số câu hỏi ngân hàng" và "Số câu mỗi chương trong đề thi". Nếu số chương > 1, AI sinh câu hỏi riêng cho từng chương (yêu cầu tài liệu có đánh dấu ranh giới chương rõ ràng, ví dụ "Chương 1", "Chương 2"...) và đề thi luôn lấy đều số câu đã cấu hình từ mỗi chương. Để "Số chương" = 1 (mặc định) nếu tài liệu không chia chương — hành vi giống bản gốc (random toàn bộ ngân hàng).
- **Cấp độ khó**: mỗi câu hỏi được Gemini gắn nhãn "Cơ bản"/"Trung bình"/"Nâng cao" (dùng nội bộ, không hiện ra giao diện). Khi random đề thi, mỗi chương được chọn đều số câu ở cả 3 mức để đề không lệch toàn dễ hoặc toàn khó, sau đó xáo trộn ngẫu nhiên thứ tự — không sắp theo dễ-khó.
- **Đề thi cố định & cho làm lại nhiều lần**: 2 checkbox trên trang Upload. "Đề thi cố định" khiến `/api/get-quiz` trả về TOÀN BỘ ngân hàng câu hỏi (không random subset), theo 1 thứ tự ổn định (sắp theo chương rồi theo id) giống nhau ở mọi lượt làm — phù hợp khi muốn ngân hàng câu hỏi (vd 300 câu, 100 câu/chương) chính là đề thi. "Cho phép làm nhiều lần" tắt việc chặn nộp bài lần 2 theo Họ tên+Lớp; mỗi lượt nộp vẫn được ghi thành 1 dòng riêng trong Google Sheets. Cấu hình được lưu trong `ExamConfig` (Redis) khi upload hoàn tất, sinh viên có thể kiểm tra qua `GET /api/get-exam-info` (public).
