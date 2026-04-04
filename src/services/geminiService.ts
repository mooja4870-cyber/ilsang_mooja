import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { UserInput, BlogPost } from "../types";

function toSafeMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
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
    message.toLowerCase().includes("resource_exhausted")
  );
}

const MAX_QUOTA_RETRY_COUNT = 1;
const DEFAULT_QUOTA_RETRY_DELAY_SECONDS = 22;
const MAX_RETRY_DELAY_SECONDS = 60;

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

function toUserFriendlyError(error: unknown): Error {
  const message = toSafeMessage(error);
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("api_key_invalid")) {
    return new Error("API 키가 유효하지 않습니다. 키 값을 다시 확인해주세요.");
  }

  if (isQuotaExceededMessage(message)) {
    const retryDelaySeconds = parseRetryDelaySeconds(message);
    if (retryDelaySeconds && retryDelaySeconds > 0) {
      return new Error(
        `Gemini 사용량 한도를 초과했습니다. 약 ${retryDelaySeconds}초 후 다시 시도해주세요. 계속 실패하면 다른 API 키를 사용해주세요.`
      );
    }
    return new Error(
      "Gemini 사용량 한도를 초과했습니다. 잠시 후 다시 시도하거나 다른 API 키를 사용해주세요."
    );
  }

  if (lowerMessage.includes("rate limit")) {
    return new Error("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.");
  }

  return new Error("블로그 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
}

export async function generateBlogPost(input: UserInput): Promise<BlogPost> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY가 설정되지 않았습니다. 환경 변수를 확인해주세요.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const textPart = {
    text: `
      You are an expert SEO blog writer specializing in high-quality Korean blog posts that rank high on search engines (Naver, Google).
      Generate a blog post based on the following information and the provided images:
      - Location: ${input.location.join(", ")}
      - Purposes: ${input.purposes.join(", ")}
      - People in photos: ${input.people || "None specified"}
      - Target length: ${input.length} characters (excluding spaces). **STRICT LIMIT: DO NOT EXCEED 2,000 CHARACTERS.**
      - Number of sections: ${input.sections}
      - Number of images: ${input.images.length}

      SEO Writing Guidelines:
      1. Title: Create a high-CTR, SEO-optimized title. Use power words and numbers if appropriate.
      2. Structure: Use a clear introduction, body sections with subheadings, and a conclusion.
      3. Content: Write in a natural, engaging, and helpful tone. Avoid repetitive phrases.
      4. Image Integration: 
         - Analyze each image carefully.
         - Place [IMAGE_1], [IMAGE_2], etc., where they naturally fit the narrative.
         - **IMAGE GROUPING**: For longer posts (near 2,000 characters), you may group 2 or 3 images together (e.g., [IMAGE_1][IMAGE_2] or [IMAGE_1][IMAGE_2][IMAGE_3]) between paragraphs or sections to maintain visual flow and prevent the text from feeling too dense.
         - Describe the visual details from the photos in the surrounding text to improve relevance.
      5. Keywords: Naturally incorporate relevant keywords throughout the text.
      6. Formatting: Use bullet points or numbered lists where it makes sense to improve readability.

      Response Requirements:
      1. Title: Catchy and SEO-friendly.
      2. Quote: A meaningful opening quote that sets the mood.
      3. Sections: Exactly ${input.sections} sections. Each section should start with a clear subheading (e.g., "## Subheading").
      4. SEO Keywords: Provide 5-10 specific keywords used for this post.

      Return the response in JSON format.
    `
  };

  const imageParts = input.images.map((base64, index) => {
    const [mimePart, dataPart] = base64.split(',');
    const mimeType = mimePart.match(/:(.*?);/)?.[1] || "image/jpeg";
    return {
      inlineData: {
        data: dataPart,
        mimeType: mimeType
      }
    };
  });

  for (let attempt = 0; attempt <= MAX_QUOTA_RETRY_COUNT; attempt += 1) {
    try {
      const response: GenerateContentResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
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
          }
        }
      });

      if (!response.text) {
        throw new Error("AI가 응답을 생성하지 못했습니다.");
      }

      return JSON.parse(response.text);
    } catch (error: unknown) {
      const message = toSafeMessage(error);
      const canRetry = attempt < MAX_QUOTA_RETRY_COUNT;

      if (isQuotaExceededMessage(message) && canRetry) {
        const retryDelaySeconds = getRetryDelaySeconds(message);
        console.warn(
          `Gemini quota exceeded. Retry in ${retryDelaySeconds}s (attempt ${attempt + 2}/${MAX_QUOTA_RETRY_COUNT + 1})`
        );
        await wait(retryDelaySeconds * 1000);
        continue;
      }

      console.error("Gemini API Error:", error);
      throw toUserFriendlyError(error);
    }
  }

  throw new Error("블로그 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
}
