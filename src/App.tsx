import { Suspense, lazy } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { TeacherAuthProvider } from "./context/TeacherAuthContext";
import { ToastContainer } from "./components/ToastContainer";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { HomePage } from "./pages/HomePage";
import { TeacherLoginPage } from "./pages/teacher/TeacherLoginPage";
import { TeacherLayout } from "./pages/teacher/TeacherLayout";
import { TeacherUploadPage } from "./pages/teacher/TeacherUploadPage";
import { TeacherLecturePage } from "./pages/teacher/TeacherLecturePage";
import { StudentLecturePage } from "./pages/student/StudentLecturePage";
import { StudentTestPage } from "./pages/student/StudentTestPage";

// Tách riêng vì trang này kéo theo thư viện xlsx (nặng, chỉ giảng viên dùng để xuất Excel)
const TeacherResultsPage = lazy(() =>
  import("./pages/teacher/TeacherResultsPage").then((m) => ({ default: m.TeacherResultsPage }))
);

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <TeacherAuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/teacher/login" element={<TeacherLoginPage />} />
              <Route path="/teacher" element={<TeacherLayout />}>
                <Route path="upload" element={<TeacherUploadPage />} />
                <Route path="lecture" element={<TeacherLecturePage />} />
                <Route
                  path="results"
                  element={
                    <Suspense fallback={<LoadingOverlay message="Đang tải..." />}>
                      <TeacherResultsPage />
                    </Suspense>
                  }
                />
              </Route>
              <Route path="/student" element={<StudentLecturePage />} />
              <Route path="/student/test" element={<StudentTestPage />} />
            </Routes>
          </BrowserRouter>
          <ToastContainer />
        </TeacherAuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
