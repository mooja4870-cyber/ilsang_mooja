import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { UserInput, BlogPost } from "../types";

type GeminiErrorCode =
  | "API_KEY_MISSING"
  | "API_KEY_INVALID"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "MODEL_UNAVAILABLE"
  | "PROMPT_BLOCKED"
  | "NETWORK_TEMPORARY"
  | "UNKNOWN";

interface GeminiError extends Error {
  code?: GeminiErrorCode;
  retryAfterSeconds?: number;
  model?: string;
  responseId?: string;
}

function toSafeMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}

function toGeminiError(
  code: GeminiErrorCode,
  message: string,
  extras?: Partial<Pick<GeminiError, "retryAfterSeconds" | "model" | "responseId">>
): GeminiError {
  const err = new Error(message) as GeminiError;
  err.code = code;
  if (typeof extras?.retryAfterSeconds === "number") err.retryAfterSeconds = extras.retryAfterSeconds;
  if (extras?.model) err.model = extras.model;
  if (extras?.responseId) err.responseId = extras.responseId;
  return err;
}

function parseRetryDelaySeconds(message: string): number | null {
  const quotedMatch = message.match(/"retryDelay":"(\d+)s"/i);
  if (quotedMatch) return Number(quotedMatch[1]);

  const plainMatch = message.match(/retryDelay[^0-9]*(\d+)s/i);
  if (plainMatch) return Number(plainMatch[1]);

  return null;
}

function isQuotaExceededMessage(message: string): boolean {
  return (
    message.includes('"code":429') ||
    message.includes("429") ||
    message.toLowerCase().includes("quota exceeded") ||
    message.toLowerCase().includes("resource_exhausted") ||
    message.toLowerCase().includes("resource exhausted")
  );
}

function isRateLimitedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429");
}

function isApiKeyInvalidMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("api_key_invalid") ||
    lower.includes("api key not valid") ||
    lower.includes("request had invalid authentication credentials") ||
    lower.includes("permission denied")
  );
}

function isModelUnavailableMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    (lower.includes("models/") && lower.includes("not found")) ||
    lower.includes("is not found for api version") ||
    lower.includes("unsupported model") ||
    lower.includes("model is unavailable")
  );
}

function isTransientMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('"code":500') ||
    lower.includes('"code":502') ||
    lower.includes('"code":503') ||
    lower.includes('"code":504') ||
    lower.includes("internal") ||
    lower.includes("unavailable") ||
    lower.includes("temporarily") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("deadline exceeded") ||
    lower.includes("networkerror") ||
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed")
  );
}

function parseJsonFallback(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("EMPTY_JSON_TEXT");

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue to fallback strategies
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) {
    try {
      return JSON.parse(fenced);
    } catch {
      // continue to fallback strategies
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // handled below
    }
  }

  throw new Error("INVALID_JSON_TEXT");
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueNonEmpty(items: Array<string | undefined | null>): string[] {
  return Array.from(new Set(items.map((item) => (item || "").trim()).filter(Boolean)));
}

function normalizeKeywords(rawKeywords: string[], input: UserInput): string[] {
  const seedKeywords = [
    ...rawKeywords,
    ...input.location,
    ...input.purposes,
    "일상",
    "사진기록",
    "네이버블로그",
    "데이트코스",
    "감성기록",
    "하루기록",
    "주말추천",
  ];

  return uniqueNonEmpty(seedKeywords).slice(0, 9);
}

function normalizeSections(rawSections: string[], sectionCount: number): string[] {
  const normalized = rawSections.slice(0, sectionCount).map((section, index) => {
    const safeSection = section.trim();
    if (!safeSection) {
      return `소제목 ${index + 1}\n사진의 분위기와 장면을 중심으로 오늘의 기록을 담아봅니다.`;
    }

    if (!safeSection.includes("\n")) {
      return `소제목 ${index + 1}\n${safeSection}`;
    }

    return safeSection;
  });

  while (normalized.length < sectionCount) {
    const index = normalized.length;
    normalized.push(`소제목 ${index + 1}\n사진의 분위기와 장면을 중심으로 오늘의 기록을 담아봅니다.`);
  }

  return normalized;
}

function normalizeBlogPostPayload(payload: unknown, input: UserInput): BlogPost {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  const title =
    toStringValue(obj.title) ||
    `${input.location[0] || "일상"} 사진 기록`;

  const quote =
    toStringValue(obj.quote) ||
    "\"오늘의 순간을 기록하는 마음으로 하루를 담아봅니다.\"\n- 작자 미상 -";

  const sections = normalizeSections(toStringArray(obj.sections), input.sections);
  const seoKeywords = normalizeKeywords(toStringArray(obj.seoKeywords), input);

  return { title, quote, sections, seoKeywords };
}

function getPromptBlockMessage(response: GenerateContentResponse): string | null {
  const blockReason = String(response.promptFeedback?.blockReason || "");
  if (blockReason && blockReason !== "BLOCKED_REASON_UNSPECIFIED") {
    return "입력한 내용이 안전 정책에 의해 차단되었습니다. 표현을 조금 순화해서 다시 시도해주세요.";
  }

  const finishReason = String(response.candidates?.[0]?.finishReason || "");
  if (
    finishReason === "SAFETY" ||
    finishReason === "BLOCKLIST" ||
    finishReason === "PROHIBITED_CONTENT" ||
    finishReason === "SPII"
  ) {
    return "생성 결과가 안전 정책에 의해 차단되었습니다. 표현을 완화하거나 민감한 내용을 줄여 다시 시도해주세요.";
  }

  return null;
}

function getModelCandidates(): string[] {
  const win = typeof window !== "undefined" ? (window as any) : {};
  const env = typeof process !== "undefined" ? process.env : {};

  return uniqueNonEmpty([
    win?.GEMINI_MODEL,
    env?.VITE_GEMINI_MODEL,
    env?.GEMINI_MODEL,
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.0-flash",
  ]);
}

const MAX_QUOTA_RETRY_COUNT = 2;
const MAX_TRANSIENT_RETRY_COUNT = 2;
const MAX_PARSE_RETRY_COUNT = 1;
const DEFAULT_QUOTA_RETRY_DELAY_SECONDS = 22;
const MAX_RETRY_DELAY_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 32;
const GENERATE_TIMEOUT_MS = 45_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRetryDelaySeconds(message: string): number {
  const parsed = parseRetryDelaySeconds(message);
  if (!parsed || Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_QUOTA_RETRY_DELAY_SECONDS;
  }
  return Math.min(parsed, MAX_RETRY_DELAY_SECONDS);
}

function getTransientBackoffSeconds(attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_SECONDS, 2 ** attempt);
  const jitter = Math.random();
  return exp + jitter;
}

function isKnownGeminiErrorCode(code: unknown): code is GeminiErrorCode {
  return (
    code === "API_KEY_MISSING" ||
    code === "API_KEY_INVALID" ||
    code === "QUOTA_EXCEEDED" ||
    code === "RATE_LIMITED" ||
    code === "MODEL_UNAVAILABLE" ||
    code === "PROMPT_BLOCKED" ||
    code === "NETWORK_TEMPORARY" ||
    code === "UNKNOWN"
  );
}

function toUserFriendlyError(error: unknown): GeminiError {
  if (error && typeof error === "object" && isKnownGeminiErrorCode((error as GeminiError).code)) {
    return error as GeminiError;
  }

  const message = toSafeMessage(error);
  const lowerMessage = message.toLowerCase();

  if (isApiKeyInvalidMessage(message)) {
    return toGeminiError("API_KEY_INVALID", "API 키가 유효하지 않습니다. 키 값을 다시 확인해주세요.");
  }

  if (isQuotaExceededMessage(message)) {
    const retryDelaySeconds = parseRetryDelaySeconds(message);
    if (retryDelaySeconds && retryDelaySeconds > 0) {
      return toGeminiError(
        "QUOTA_EXCEEDED",
        `Gemini 사용량 한도를 초과했습니다. 약 ${retryDelaySeconds}초 후 다시 시도해주세요. 계속 실패하면 다른 API 키를 사용해주세요.`,
        { retryAfterSeconds: retryDelaySeconds },
      );
    }
    return toGeminiError(
      "QUOTA_EXCEEDED",
      "Gemini 사용량 한도를 초과했습니다. 잠시 후 다시 시도하거나 다른 API 키를 사용해주세요.",
    );
  }

  if (isRateLimitedMessage(message)) {
    return toGeminiError("RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.");
  }

  if (isModelUnavailableMessage(message)) {
    return toGeminiError(
      "MODEL_UNAVAILABLE",
      "현재 설정된 Gemini 모델이 더 이상 제공되지 않습니다. 최신 모델로 자동 전환해 다시 시도해주세요."
    );
  }

  if (isTransientMessage(message)) {
    return toGeminiError(
      "NETWORK_TEMPORARY",
      "Gemini 연결이 일시적으로 불안정합니다. 잠시 후 자동 재시도하거나 다시 시도해주세요."
    );
  }

  if (lowerMessage.includes("empty_json_text") || lowerMessage.includes("invalid_json_text")) {
    return toGeminiError("UNKNOWN", "AI 응답 형식이 일시적으로 불안정했습니다. 자동 재시도 후에도 실패했습니다.");
  }

  return toGeminiError("UNKNOWN", "블로그 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
}

export async function generateBlogPost(input: UserInput, dynamicApiKey?: string): Promise<BlogPost> {
  const apiKey = dynamicApiKey || process.env.GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
  if (!apiKey) {
    throw toGeminiError("API_KEY_MISSING", "API 키가 없습니다. 설정에서 서버 주소를 확인하거나 .env.local 설정을 확인해주세요.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const models = getModelCandidates();

  const textPart = {
    text: `
      You are an expert Korean blog writer for Naver autoposting.
      Generate a structured post based on the following information and the provided images:
      - Location: ${input.location.join(", ")}
      - Purposes: ${input.purposes.join(", ")}
      - People in photos: ${input.people || "None specified"}
      - Target length: around ${input.length} characters
      - Number of sections: exactly ${input.sections}
      - Number of images: ${input.images.length}

      Core Rules:
      1. Image count = section count. (1 image per section)
      2. Each section must follow this exact structure:
         - first line: subtitle only (about 15 Korean characters)
         - second+ lines: body text only (about 100 Korean characters)
      3. Body priority: image scene details > season context > date mood.
      4. Body sentences must be easy to split by periods.
      5. Do not include [IMAGE_X] markers.
      6. Keep all writing natural Korean for Naver blog readers.

      Response Requirements:
      1. title: catchy Korean title.
      2. quote: must be exactly this 2-line format:
         "quote sentence"
         - philosopher name -
      3. sections: exactly ${input.sections} items.
         - each section string format:
           subtitle line + newline + body line(s)
         - do not include section numbers like "섹션 1", "섹션 2".
      4. seoKeywords: exactly 9 hashtag keywords without #.

      Return the response in JSON format.
    `
  };

  const imageParts = input.images.map((base64) => {
    const [mimePart, dataPart] = base64.split(',');
    const mimeType = mimePart.match(/:(.*?);/)?.[1] || "image/jpeg";
    return {
      inlineData: {
        data: dataPart,
        mimeType: mimeType
      }
    };
  });

  let lastError: unknown = null;

  for (const model of models) {
    let quotaRetryCount = 0;
    let transientRetryCount = 0;
    let parseRetryCount = 0;

    for (;;) {
      try {
        const response: GenerateContentResponse = await ai.models.generateContent({
          model,
          contents: {
            parts: [textPart, ...imageParts]
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                quote: { type: Type.STRING },
                sections: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                seoKeywords: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                }
              },
              required: ["title", "quote", "sections", "seoKeywords"]
            },
            temperature: 0.6,
            maxOutputTokens: 4096,
            httpOptions: {
              timeout: GENERATE_TIMEOUT_MS,
              retryOptions: { attempts: 1 },
            },
          }
        });

        const promptBlocked = getPromptBlockMessage(response);
        if (promptBlocked) {
          throw toGeminiError("PROMPT_BLOCKED", promptBlocked, {
            model,
            responseId: response.responseId,
          });
        }

        if (!response.text) {
          throw new Error("EMPTY_JSON_TEXT");
        }

        const payload = parseJsonFallback(response.text);
        return normalizeBlogPostPayload(payload, input);
      } catch (error: unknown) {
        lastError = error;
        const message = toSafeMessage(error);

        if (isModelUnavailableMessage(message)) {
          console.warn(`[Gemini] model unavailable -> switch model: ${model}`);
          break;
        }

        if (isQuotaExceededMessage(message) && quotaRetryCount < MAX_QUOTA_RETRY_COUNT) {
          quotaRetryCount += 1;
          const retryDelaySeconds = getRetryDelaySeconds(message);
          console.warn(
            `[Gemini] quota exceeded on ${model}. retry in ${retryDelaySeconds}s (${quotaRetryCount}/${MAX_QUOTA_RETRY_COUNT})`
          );
          await wait(retryDelaySeconds * 1000);
          continue;
        }

        if (isTransientMessage(message) && transientRetryCount < MAX_TRANSIENT_RETRY_COUNT) {
          transientRetryCount += 1;
          const waitSeconds = getTransientBackoffSeconds(transientRetryCount);
          console.warn(
            `[Gemini] transient error on ${model}. retry in ${waitSeconds.toFixed(2)}s (${transientRetryCount}/${MAX_TRANSIENT_RETRY_COUNT})`
          );
          await wait(waitSeconds * 1000);
          continue;
        }

        if (
          (message.includes("EMPTY_JSON_TEXT") || message.includes("INVALID_JSON_TEXT")) &&
          parseRetryCount < MAX_PARSE_RETRY_COUNT
        ) {
          parseRetryCount += 1;
          console.warn(
            `[Gemini] parse instability on ${model}. retry (${parseRetryCount}/${MAX_PARSE_RETRY_COUNT})`
          );
          await wait(1200);
          continue;
        }

        break;
      }
    }
  }

  console.error("Gemini API Error:", lastError);
  throw toUserFriendlyError(lastError);
}
