import express from "express";
import path from "path";
import dotenv from "dotenv";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import { publishToNaver, closeGlobalBrowser } from "./naverPublisher";
import { generateBlogPost } from "./src/services/geminiService";
import type { UserInput } from "./src/types";

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

interface ServerGeminiError extends Error {
  code?: string;
  retryAfterSeconds?: number;
  model?: string;
  responseId?: string;
}

const GEMINI_KEY_COOLDOWN_DEFAULT_SECONDS = 30;
const GEMINI_KEY_COOLDOWN_INVALID_SECONDS = 600;
const GEMINI_KEY_COOLDOWN_MAX_SECONDS = 600;
const geminiKeyCooldownUntil = new Map<string, number>();

function parseGeminiApiKeysFromEnv() {
  const merged = [
    process.env.GEMINI_API_KEYS || "",
    process.env.GEMINI_API_KEY || "",
    process.env.VITE_GEMINI_API_KEY || "",
  ].join(",");

  return Array.from(
    new Set(
      merged
        .split(/[,\n]/)
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  );
}

function toMaskedKey(apiKey: string) {
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function toSafeInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function toSafeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toSafeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toSafeString(item))
    .filter(Boolean);
}

function getGeminiKeyCooldownMs(apiKey: string) {
  return geminiKeyCooldownUntil.get(apiKey) || 0;
}

function getEarliestGeminiKeyCooldownMs(keys: string[]) {
  let earliest = 0;
  for (const key of keys) {
    const until = getGeminiKeyCooldownMs(key);
    if (until > 0 && (earliest === 0 || until < earliest)) {
      earliest = until;
    }
  }
  return earliest;
}

function cleanGeminiKeyCooldownMap(keys: string[]) {
  const keySet = new Set(keys);
  for (const savedKey of geminiKeyCooldownUntil.keys()) {
    if (!keySet.has(savedKey)) {
      geminiKeyCooldownUntil.delete(savedKey);
    }
  }
}

function setGeminiKeyCooldown(apiKey: string, retryAfterSeconds?: number) {
  const safeSeconds = toSafeInteger(
    retryAfterSeconds,
    GEMINI_KEY_COOLDOWN_DEFAULT_SECONDS,
    5,
    GEMINI_KEY_COOLDOWN_MAX_SECONDS,
  );
  const until = Date.now() + safeSeconds * 1000;
  geminiKeyCooldownUntil.set(apiKey, until);
  return safeSeconds;
}

function normalizeGenerateInput(payload: any): UserInput {
  const images = toSafeStringArray(payload?.images)
    .filter((img) => img.startsWith("data:image/"))
    .slice(0, 10);

  const location = toSafeStringArray(payload?.location).slice(0, 10);
  const purposes = toSafeStringArray(payload?.purposes).slice(0, 10);
  const people = toSafeString(payload?.people);
  const defaultSections = images.length > 0 ? images.length : 1;
  const sections = toSafeInteger(payload?.sections, defaultSections, 1, 10);
  const length = toSafeInteger(payload?.length, 380, 120, 4000);

  return {
    location: location.length > 0 ? location : ["일상"],
    purposes: purposes.length > 0 ? purposes : ["네이버 자동 포스팅"],
    people,
    length,
    sections: images.length > 0 ? images.length : sections,
    images,
  };
}

function isQuotaLikeCode(code: string) {
  return code === "QUOTA_EXCEEDED" || code === "RATE_LIMITED";
}

async function generatePostThroughGeminiKeyPool(input: UserInput) {
  const keys = parseGeminiApiKeysFromEnv();
  cleanGeminiKeyCooldownMap(keys);

  if (keys.length === 0) {
    const err = new Error("Gemini API 키가 설정되지 않았습니다.") as ServerGeminiError;
    err.code = "API_KEY_MISSING";
    throw err;
  }

  const now = Date.now();
  const sortedKeys = [...keys].sort((a, b) => getGeminiKeyCooldownMs(a) - getGeminiKeyCooldownMs(b));
  let lastError: ServerGeminiError | null = null;
  let invalidKeyCount = 0;

  for (const apiKey of sortedKeys) {
    const cooldownUntil = getGeminiKeyCooldownMs(apiKey);
    if (cooldownUntil > now) continue;

    try {
      return await generateBlogPost(input, apiKey);
    } catch (error: any) {
      const geminiError = error as ServerGeminiError;
      const code = String(geminiError?.code || "");
      lastError = geminiError;

      if (isQuotaLikeCode(code)) {
        const appliedCooldown = setGeminiKeyCooldown(apiKey, geminiError.retryAfterSeconds);
        console.warn(
          `[Gemini] key cooldown applied (${appliedCooldown}s) due to ${code}: ${toMaskedKey(apiKey)}`
        );
        continue;
      }

      if (code === "API_KEY_INVALID") {
        invalidKeyCount += 1;
        const appliedCooldown = setGeminiKeyCooldown(apiKey, GEMINI_KEY_COOLDOWN_INVALID_SECONDS);
        console.warn(
          `[Gemini] invalid key detected (${appliedCooldown}s hold): ${toMaskedKey(apiKey)}`
        );
        continue;
      }

      throw geminiError;
    }
  }

  if (invalidKeyCount >= keys.length) {
    const err = new Error("등록된 Gemini API 키가 유효하지 않습니다. 키를 확인해주세요.") as ServerGeminiError;
    err.code = "API_KEY_INVALID";
    throw err;
  }

  const earliestCooldownMs = getEarliestGeminiKeyCooldownMs(keys);
  const retryAfterSeconds =
    earliestCooldownMs > now
      ? Math.max(1, Math.ceil((earliestCooldownMs - now) / 1000))
      : GEMINI_KEY_COOLDOWN_DEFAULT_SECONDS;

  const quotaError = new Error("Gemini API 사용량을 초과했습니다. 잠시 후 다시 시도해 주세요.") as ServerGeminiError;
  quotaError.code = "QUOTA_EXCEEDED";
  quotaError.retryAfterSeconds = retryAfterSeconds;
  if (lastError?.responseId) quotaError.responseId = lastError.responseId;
  throw quotaError;
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
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  }));
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  const naverBlogId = (process.env.NAVER_BLOG_ID || "").trim();
  const naverEditorUrl = naverBlogId
    ? `https://blog.naver.com/${encodeURIComponent(naverBlogId)}/postwrite`
    : "https://blog.naver.com";

  app.get("/api/health", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      service: "ilsang-mooja",
      time: new Date().toISOString(),
      nodeEnv: process.env.NODE_ENV || "development",
    });
  });

  app.get("/api/config", (req, res) => {
    const keys = parseGeminiApiKeysFromEnv();
    const earliestCooldownMs = getEarliestGeminiKeyCooldownMs(keys);
    const now = Date.now();
    const geminiRetryAfterSeconds =
      earliestCooldownMs > now ? Math.max(1, Math.ceil((earliestCooldownMs - now) / 1000)) : 0;

    res.set("Cache-Control", "no-store");
    res.json({
      geminiEnabled: keys.length > 0,
      geminiRetryAfterSeconds,
      geminiApiKey: "",
    });
  });

  app.post("/api/generate-blog", async (req, res) => {
    const input = normalizeGenerateInput(req.body);
    if (input.images.length === 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_INPUT",
        message: "최소 1장 이상의 이미지가 필요합니다.",
      });
    }

    try {
      const post = await generatePostThroughGeminiKeyPool(input);
      res.set("Cache-Control", "no-store");
      return res.json({
        success: true,
        post,
      });
    } catch (error: any) {
      const geminiError = error as ServerGeminiError;
      const code = String(geminiError?.code || "UNKNOWN");
      const message = toSafeString(geminiError?.message) || "블로그 생성 중 오류가 발생했습니다.";

      if (isQuotaLikeCode(code)) {
        const retryAfterSeconds = toSafeInteger(
          geminiError?.retryAfterSeconds,
          GEMINI_KEY_COOLDOWN_DEFAULT_SECONDS,
          1,
          GEMINI_KEY_COOLDOWN_MAX_SECONDS,
        );
        const nextRetryAt = Date.now() + retryAfterSeconds * 1000;
        return res.status(429).json({
          success: false,
          code,
          message,
          retryAfterSeconds,
          nextRetryAt,
        });
      }

      if (code === "PROMPT_BLOCKED") {
        return res.status(422).json({
          success: false,
          code,
          message,
        });
      }

      if (code === "API_KEY_MISSING" || code === "API_KEY_INVALID") {
        return res.status(503).json({
          success: false,
          code,
          message,
        });
      }

      return res.status(500).json({
        success: false,
        code: "UNKNOWN",
        message,
      });
    }
  });

  app.post("/api/publish", async (req, res) => {
    try {
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

      console.log(`\x1b[36m[POSTING]\x1b[0m Publishing to Naver... (Images: ${images?.length || 0})`);
      
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

      console.log(`\x1b[32m[SUCCESS]\x1b[0m Blog published: ${result.postUrl || 'Success'}`);

      return res.json({
        success: true,
        reason: result.reason,
        message: result.message,
        url: result.postUrl,
        editorUrl: naverEditorUrl,
        contentLength: result.contentLength,
      });
    } catch (error: any) {
      console.error("\x1b[31m[ERROR]\x1b[0m Naver publish failed:", error.message);
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

  const server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`\x1b[32m[LOCAL]\x1b[0m Server running on http://localhost:${PORT}`);

    const shouldCreateTunnel =
      process.env.ENABLE_LOCALTUNNEL === "true" || process.env.NODE_ENV !== "production";
    if (!shouldCreateTunnel) return;

    // --- 로컬 개발용: HTTPS 터널 생성 ---
    try {
      const localtunnel = (await import("localtunnel")).default;
      const tunnel = await localtunnel({ port: PORT });
      console.log(`\x1b[35m[HTTPS]\x1b[0m Your secure public URL: \x1b[1m${tunnel.url}\x1b[0m`);
      console.log(`\x1b[33m[TIP]\x1b[0m Copy this URL to the [Settings] modal in myilsang.streamlit.app to CONNECT!`);

      tunnel.on("close", () => {
        console.log("Tunnel closed");
      });
    } catch (err) {
      console.error("Failed to create HTTPS tunnel:", err);
    }
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
