import express from "express";
import path from "path";
import dotenv from "dotenv";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import { publishToNaver, closeGlobalBrowser } from "./naverPublisher";

dotenv.config({ path: ".env.local" });
dotenv.config();

function normalizeEscapedLineBreaks(text: string) {
  let normalized = text.replace(/\r/g, "\n");

  for (let i = 0; i < 3; i += 1) {
    const next = normalized
      .replace(/\\\\r\\\\n/g, "\n")
      .replace(/\\\\n/g, "\n")
      .replace(/\\\\r/g, "\n")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n");

    if (next === normalized) break;
    normalized = next;
  }

  return normalized.replace(/\n{3,}/g, "\n\n").trim();
}

type PublishAsyncStatus = "queued" | "running" | "success" | "failed";

interface PublishAsyncJob {
  id: string;
  status: PublishAsyncStatus;
  reason: string;
  message: string;
  url: string;
  contentLength: number;
  screenshotPath: string;
  tracePath: string;
  createdAt: number;
  updatedAt: number;
}

const publishJobs = new Map<string, PublishAsyncJob>();
const MAX_PUBLISH_JOBS = 80;

function createPublishJobId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function trimPublishJobs() {
  if (publishJobs.size <= MAX_PUBLISH_JOBS) return;
  const overflow = publishJobs.size - MAX_PUBLISH_JOBS;
  const oldest = Array.from(publishJobs.entries())
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, overflow);

  for (const [jobId] of oldest) {
    publishJobs.delete(jobId);
  }
}

function createPublishJob() {
  const now = Date.now();
  const id = createPublishJobId();
  const job: PublishAsyncJob = {
    id,
    status: "queued",
    reason: "",
    message: "발행 요청을 접수했습니다. 네이버 처리 대기 중입니다.",
    url: "",
    contentLength: 0,
    screenshotPath: "",
    tracePath: "",
    createdAt: now,
    updatedAt: now,
  };
  publishJobs.set(id, job);
  trimPublishJobs();
  return job;
}

function updatePublishJob(jobId: string, patch: Partial<PublishAsyncJob>) {
  const previous = publishJobs.get(jobId);
  if (!previous) return;

  publishJobs.set(jobId, {
    ...previous,
    ...patch,
    updatedAt: Date.now(),
  });
}

async function runPublishJob(jobId: string, title: string, content: string, images: string[]) {
  updatePublishJob(jobId, {
    status: "running",
    message: "네이버에 발행 처리 중입니다.",
  });

  try {
    const result = await publishToNaver({ title, content, images });
    if (!result.ok) {
      updatePublishJob(jobId, {
        status: "failed",
        reason: result.reason || "POST_FAIL",
        message: result.message || "발행 처리 중 오류가 발생했습니다.",
        url: result.postUrl || "",
        contentLength: result.contentLength || 0,
        screenshotPath: result.screenshotPath || "",
        tracePath: result.tracePath || "",
      });
      return;
    }

    updatePublishJob(jobId, {
      status: "success",
      reason: result.reason || "OK",
      message: result.message || "네이버 블로그 발행이 완료되었습니다.",
      url: result.postUrl || "",
      contentLength: result.contentLength || 0,
      screenshotPath: "",
      tracePath: "",
    });
  } catch (error: any) {
    console.error("Naver publish async error:", error);
    updatePublishJob(jobId, {
      status: "failed",
      reason: "UNKNOWN",
      message: error?.message || "발행 처리 중 오류가 발생했습니다.",
      url: "",
      contentLength: 0,
      screenshotPath: "",
      tracePath: "",
    });
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  
  // CORS 설정: Streamlit Cloud로부터의 외부 요청 허용
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  const naverBlogId = (process.env.NAVER_BLOG_ID || "").trim();
  const naverEditorUrl = naverBlogId
    ? `https://blog.naver.com/${encodeURIComponent(naverBlogId)}/postwrite`
    : "https://blog.naver.com";

  app.get("/api/config", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      geminiApiKey: process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || "",
    });
  });

  app.post("/api/publish", async (req, res) => {
    const { title, content, images, quote, quoteText, quoteAuthor, sections, hashtags } = req.body || {};
    const normalizedContent = typeof content === "string" ? normalizeEscapedLineBreaks(content) : "";

    if (!title || !normalizedContent) {
      return res.status(400).json({
        success: false,
        reason: "POST_FAIL",
        message: "title과 content는 필수입니다.",
        url: "",
      });
    }

    try {
      const result = await publishToNaver({
        title,
        content: normalizedContent,
        images,
        quote,
        quoteText,
        quoteAuthor,
        sections,
        hashtags,
      });
      if (!result.ok) {
        return res.status(500).json({
          success: false,
          reason: result.reason,
          message: result.message,
          screenshotPath: result.screenshotPath || "",
          tracePath: result.tracePath || "",
          url: result.postUrl || "",
          contentLength: result.contentLength || 0,
        });
      }

      return res.json({
        success: true,
        reason: result.reason,
        message: result.message,
        url: result.postUrl,
        editorUrl: naverEditorUrl,
        contentLength: result.contentLength,
      });
    } catch (error: any) {
      console.error("Naver publish error:", error);
      return res.status(500).json({
        success: false,
        reason: "UNKNOWN",
        message: error?.message || "발행 처리 중 오류가 발생했습니다.",
        url: "",
      });
    }
  });

  app.post("/api/publish-async", async (req, res) => {
    const { title, content, images } = req.body || {};
    const normalizedContent = typeof content === "string" ? normalizeEscapedLineBreaks(content) : "";

    if (!title || !normalizedContent) {
      return res.status(400).json({
        success: false,
        reason: "POST_FAIL",
        message: "title과 content는 필수입니다.",
        url: "",
      });
    }

    const imageList = Array.isArray(images) ? images : [];
    const job = createPublishJob();

    res.status(202).json({
      success: true,
      status: job.status,
      jobId: job.id,
      message: job.message,
      acceptedAt: job.createdAt,
    });

    void runPublishJob(job.id, title, normalizedContent, imageList);
  });

  app.get("/api/publish-status/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = publishJobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        reason: "NOT_FOUND",
        message: "해당 발행 작업을 찾지 못했습니다.",
      });
    }

    const done = job.status === "success" || job.status === "failed";
    res.set("Cache-Control", "no-store");
    return res.json({
      success: job.status === "success",
      done,
      jobId: job.id,
      status: job.status,
      reason: job.reason,
      message: job.message,
      url: job.url,
      contentLength: job.contentLength,
      screenshotPath: job.screenshotPath,
      tracePath: job.tracePath,
      acceptedAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  app.post("/api/publish-sample", async (req, res) => {
    const sampleTitle = "[테스트] 네이버 자동 발행 샘플";
    const sampleContent =
      "오늘은 네이버 자동 발행 기능을 점검하기 위한 테스트 글입니다. 로그인 후 제목, 본문, 이미지 입력과 발행 단계가 정상 완료되는지 확인합니다.";

    const sampleImages = [
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAADICAIAAABJdyC1AAABdElEQVR4nO3UQQ0AIBDAMMC/58MCP7KkVbDX9swZAIDvM+8AAPyZsQABAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBD4B8M2A7uKXu95AAAAAElFTkSuQmCC",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAADICAIAAABJdyC1AAABdElEQVR4nO3UQQ0AIBDAMMC/58MCP7KkVbC39swZAIDvM+8AAPyZsQABAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBD4B8M2A0hIhkWGAAAAAElFTkSuQmCC",
    ];

    try {
      const result = await publishToNaver({
        title: sampleTitle,
        content: sampleContent,
        images: sampleImages,
      });

      if (!result.ok) {
        return res.status(500).json({
          success: false,
          reason: result.reason,
          message: result.message,
          screenshotPath: result.screenshotPath || "",
          tracePath: result.tracePath || "",
          url: result.postUrl || "",
          contentLength: result.contentLength || 0,
        });
      }

      return res.json({
        success: true,
        reason: result.reason,
        message: result.message,
        url: result.postUrl,
        contentLength: result.contentLength,
      });
    } catch (error: any) {
      console.error("Naver sample publish error:", error);
      return res.status(500).json({
        success: false,
        reason: "UNKNOWN",
        message: error?.message || "샘플 발행 테스트 중 오류가 발생했습니다.",
        url: "",
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Graceful shutdown: clean up browser resources
  const gracefulShutdown = () => {
    console.log("Server shutting down gracefully...");
    closeGlobalBrowser();
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  };

  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);
}

startServer();
