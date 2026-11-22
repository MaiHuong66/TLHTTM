# Trợ lý học tập

Hệ thống học tập thông minh dùng Gemini API: giảng viên upload tài liệu, AI tự động tạo bài giảng và ngân hàng ~100 câu hỏi trắc nghiệm; sinh viên xem bài giảng, hỏi chatbot, làm bài kiểm tra 60 câu ngẫu nhiên và nhận kết quả/nhận xét tự động.

## Công nghệ

- React 19 + TypeScript + Vite, Tailwind CSS v4
- Vercel Serverless Functions (thư mục `api/`) — nơi duy nhất gọi Gemini API và các API khác, API key không bao giờ lộ ra frontend
- Gemini API (`@google/genai`, model mặc định `gemini-3.5-flash`, đổi được bằng biến môi trường `GEMINI_MODEL`) — đọc tài liệu, tạo bài giảng, sinh câu hỏi, chatbot, chấm điểm/nhận xét
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

## Chọn nhà cung cấp AI (Claude hoặc Gemini)

App hỗ trợ cả hai, chọn bằng biến môi trường (code ở `api/_lib/gemini.ts`, `api/_lib/claude.ts`):

- `AI_PROVIDER=claude` hoặc `gemini`. Bỏ trống: dùng **Claude nếu có `ANTHROPIC_API_KEY`**, ngược lại dùng Gemini.
- **Claude**: `ANTHROPIC_API_KEY` (lấy ở https://platform.claude.com/settings/keys), tùy chọn `CLAUDE_MODEL` (mặc định `claude-haiku-5-5`). PDF/ảnh được tải lên Claude Files API đúng 1 lần rồi tham chiếu bằng `file_id`; kết quả JSON (bài giảng, câu hỏi) lấy qua tool bắt buộc; phần tài liệu được đánh dấu prompt-cache để các bước sau đọc rẻ hơn.
- Đổi nhà cung cấp xong cần **Redeploy** trên Vercel.

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
- Việc tạo bài giảng + câu hỏi được chia thành nhiều bước độc lập (`api/upload-document.ts` khởi tạo job, `api/upload-step.ts` xử lý từng bước, mỗi bước 1 lần gọi AI nên luôn an toàn với trần 60s): bước `lecture` (bài giảng), bước `plan` (lập ma trận đề), rồi các bước `q:*` soạn câu dự phòng cho từng nhóm ô (tối đa 9 câu/bước). Trạng thái job được lưu tạm trong Redis (TTL 15 phút) để client gọi lặp lại `upload-step` cho tới khi xong; nếu 1 bước bị ngắt do hết 60s hoặc AI quá tải, client tự động thử lại đúng bước đó.
- **Chịu lỗi tạm thời của Gemini (503 "high demand", lỗi mạng)**: mọi lệnh gọi Gemini đều qua `withRetry` (`api/_lib/retry.ts`, thử lại sau 2s và 5s). Nếu vẫn lỗi, `upload-step` trả HTTP 503 mà **không** đánh dấu job thất bại; trang Upload tự gọi lại đúng bước đó (tối đa 6 lần, chờ tăng dần) và hiển thị "Gemini đang quá tải, đang thử lại...". Chỉ lỗi không tạm thời (dữ liệu sai, hết hạn mức 429...) mới làm job thất bại.
- Nếu sinh viên truy cập khi giảng viên chưa upload tài liệu nào, hệ thống sẽ hiển thị thông báo rõ ràng thay vì lỗi.
- **Ngân hàng câu hỏi + ma trận đề**: trang Upload có số câu mỗi mức trong 1 đề (mặc định 8 Nhận biết, 7 Thông hiểu, 10 Vận dụng, 5 Vận dụng cao = 30 câu), số câu dự phòng mỗi ô (2 hoặc 3, mặc định 3), giới hạn thời gian (mặc định 15 phút) và "Cho phép làm nhiều lần" (mặc định tắt). Bước `plan` (`planMatrix`) cho AI chia tài liệu thành các chủ đề con (số chủ đề = số câu của mức nhiều nhất, mặc định 10) và lập ma trận (chủ đề con × mức độ), mỗi ô ứng với 1 câu trong đề và có *trọng tâm* riêng — các ô cùng chủ đề có trọng tâm khác nhau. `repairMatrix` sửa đề xuất của AI cho đúng ràng buộc: số ô mỗi mức đúng cấu hình, mỗi chủ đề tối đa 1 ô mỗi mức, số ô giữa các chủ đề chênh không quá 1 (mặc định 10 chủ đề × 3 ô); ô nào hệ thống phải tự thêm/chuyển thì được AI đặt trọng tâm riêng ngay sau đó (`fillMissingFoci`), khác các ô cùng chủ đề. Bước lập ma trận gọi Claude không ở chế độ strict vì schema quá lớn (Claude báo "compiled grammar is too large"). Các bước `q:*` (`generateCellQuestions`) soạn N câu dự phòng cho mỗi ô: cùng trọng tâm và mức độ, khác cách hỏi/tình huống; mỗi câu lưu nhãn mức độ (`difficulty`), chủ đề con (`topic`) và ô (`cell`). Kết quả JSON dùng chế độ strict của Claude với 1 ô bắt buộc cho từng câu (`o{ô}_cau{n}`) để AI luôn trả đủ; ô còn thiếu câu được soạn lại tối đa 3 lần. Ngân hàng mặc định 90 câu.
- **Bốc đề, đảo câu và đảo đáp án**: `ExamConfig.matrixCells` lưu danh sách ô; mỗi lượt làm (`/api/get-quiz`) bốc ngẫu nhiên đúng 1 câu dự phòng từ mỗi ô — tỉ lệ mức độ luôn cố định, không lặp nội dung, các lượt khác nhau thật sự — rồi xáo thứ tự câu và thứ tự 4 đáp án của từng câu. Thứ tự đáp án được lưu trong lượt làm (`QuizAttempt.optionOrders`, xem `api/_lib/optionOrder.ts`) để `/api/submit-test` (`gradeAttempt`) đổi đáp án sinh viên chọn về đáp án gốc khi chấm và trả phần xem lại đúng theo thứ tự sinh viên đã thấy. Vì đáp án bị đảo, AI được yêu cầu không dùng phương án kiểu "Tất cả các đáp án trên" / "Cả A và B". Đề tạo theo các cách trước đây vẫn chạy theo cách cũ.
- **Giới hạn thời gian & mỗi người làm 1 lần**: ô "Giới hạn thời gian làm bài (phút)" trên trang Upload (0 = không giới hạn). Sinh viên bấm "Bắt đầu làm bài" → `POST /api/get-quiz` (kèm Họ tên + Lớp) tạo 1 *lượt làm bài* lưu trong Redis: giờ bắt đầu theo đồng hồ server, bộ câu hỏi và thứ tự câu đã random riêng cho người đó. Giao diện hiện đồng hồ đếm ngược và tự động nộp khi hết giờ (tự thử lại nếu lỗi mạng/server). `POST /api/submit-test` chấm theo đúng bộ câu server đã giao, và từ chối nộp muộn quá hạn chót + 60 giây ân hạn (client không tự kéo dài giờ được). Khi đề chỉ cho làm 1 lần: mở lại trang giữa chừng thì **tiếp tục đúng lượt đang làm dở** (cùng đề, đồng hồ vẫn chạy tiếp, đáp án đã chọn được khôi phục) chứ không được random lại hay cấp thêm giờ; đã hết giờ mà chưa nộp thì không được bắt đầu lại; đã có kết quả trong sheet thì bị chặn (xóa dòng kết quả trong sheet để cho làm lại). Hết giờ mà sinh viên chưa nộp thì không có dòng kết quả nào được ghi.
- **Giảm tải Google Sheets**: Sheets API giới hạn ~60 lượt đọc/ghi mỗi phút cho 1 tài khoản dịch vụ, nên mỗi lượt nộp chỉ còn 1 lệnh ghi (cột STT là công thức `=ROW()-1`, không cần đọc để đếm), sheet đã xác nhận tồn tại được ghi nhớ trong instance, và có tự thử lại (chờ tăng dần) khi bị 429/lỗi tạm thời. Nếu Gemini lỗi lúc viết nhận xét, điểm vẫn được ghi với nhận xét dự phòng.
