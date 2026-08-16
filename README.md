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

Sheet `Results` (chứa bảng kết quả) sẽ được ứng dụng tự động tạo ở lần ghi đầu tiên nếu chưa tồn tại — không cần tạo tay.

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
- Việc tạo bài giảng + ~100 câu hỏi được chia thành 11 bước độc lập (`api/upload-document.ts` khởi tạo job, `api/upload-step.ts` xử lý từng bước — 1 bài giảng + 10 lô câu hỏi, mỗi lô 10 câu), mỗi bước là 1 lệnh gọi Gemini riêng nên luôn chạy rất nhanh so với giới hạn 60s/lần gọi hàm của gói Hobby. Trạng thái job được lưu tạm trong Redis (TTL 15 phút) để client gọi lặp lại `upload-step` cho tới khi xong — nhờ vậy tổng thời gian xử lý không còn bị chặn bởi trần 60 giây.
- Nếu sinh viên truy cập khi giảng viên chưa upload tài liệu nào, hệ thống sẽ hiển thị thông báo rõ ràng thay vì lỗi.
- Ngân hàng câu hỏi được sinh theo 4 lô (mỗi lô ~25 câu, tập trung khía cạnh khác nhau của tài liệu) rồi lọc trùng — tổng số câu cuối cùng có thể dao động quanh mốc 100 tùy nội dung tài liệu.
