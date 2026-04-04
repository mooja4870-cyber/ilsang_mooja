import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright-core";

type ReasonCode =
  | "OK"
  | "NAVER_SESSION_MISSING"
  | "NAVER_SESSION_INVALID"
  | "NAVER_SESSION_PROBE_TIMEOUT"
  | "NAVER_WRONG_BLOG_TARGET"
  | "NAVER_CAPTCHA_REQUIRED"
  | "NAVER_LOGIN_REQUIRED"
  | "POST_FAIL"
  | "TIMEOUT"
  | "UNKNOWN";

type PublishValidationIssue = "NONE" | "TITLE_REQUIRED" | "CONTENT_REQUIRED";

interface Credentials {
  username: string;
  password: string;
  blogId: string;
}

interface PublishRequest {
  title: string;
  content: string;
  images?: string[];
  quote?: string;
  sections?: Array<{
    subtitle: string;
    body: string;
    keywords?: string[];
  }>;
  hashtags?: string[];
}

interface PublishPipelineResult {
  ok: boolean;
  reason: ReasonCode;
  postUrl: string;
  contentLength: number;
  screenshotPath?: string;
  tracePath?: string;
  message: string;
}

interface ConfirmPublishResult {
  ok: boolean;
  reason: ReasonCode;
  postUrl: string;
  message?: string;
}

interface ParagraphImagePlan {
  paragraphs: string[];
  imageGroupsByBoundary: number[][];
  imageIndexesBeforeFirstParagraph: number[];
  expectedText: string;
  canPlaceImagesBetweenParagraphs: boolean;
}

const RUNTIME_DIR = path.join(process.cwd(), ".runtime");
const SESSION_FILE = path.join(RUNTIME_DIR, "browser_session.json");
const SCREENSHOT_DIR = path.join(RUNTIME_DIR, "screenshots");
const UPLOAD_DIR = path.join(RUNTIME_DIR, "uploads");
const TRACE_DIR = path.join(RUNTIME_DIR, "traces");

const TITLE_SELECTORS = [
  ".se-title-text.se-module-text",
  ".se-title-text .se-module-text",
  ".se-section-documentTitle .se-title-text",
  "[data-placeholder='제목']",
  "div[role='textbox'][aria-label='제목']",
  "textarea.se-title-text",
  "div[contenteditable='true']",
];

const CONTENT_FOCUS_SELECTORS = [
  ".se-content-placeholder",
  ".se-section-text .se-module-text",
  ".se-main-container .se-section-text .se-module-text",
  "div[contenteditable='true']",
];

const CONTENT_VERIFY_SELECTORS = [
  ".se-main-container",
  ".se-main-container .se-section-text",
  ".se-section-text",
  ".se-text-paragraph",
  ".se-module-text",
];

const IMAGE_TOOL_SELECTORS = [
  "button[aria-label*='사진']",
  "button[aria-label*='이미지']",
  "button[aria-label*='파일']",
  "button:has-text('파일')",
  "button:has-text('사진')",
  "button:has-text('이미지')",
  "[role='button']:has-text('사진')",
  "li:has-text('사진')",
  ".se-toolbar-button-image",
  ".se-toolbar-item-image button",
];

const IMAGE_SOURCE_OPTION_SELECTORS = [
  "button:has-text('내PC')",
  "button:has-text('내 PC')",
  "button:has-text('내 컴퓨터')",
  "button:has-text('PC')",
  "a:has-text('내PC')",
  "a:has-text('내 PC')",
  "a:has-text('내 컴퓨터')",
];

const PUBLISH_OPEN_SELECTORS = [
  "button.publish_btn__m9KHH",
  "button[class*='publish_btn__']",
  ".publish_btn_v2",
  "button:has-text('발행')",
  "button[aria-label='발행']",
];

const PUBLISH_CONFIRM_SELECTORS = [
  "button.confirm_btn__WEaBq",
  "button[class*='confirm_btn__']",
  ".publish_layer_footer .btn_publish",
  ".btn_publish",
  "button:has-text('공개 발행')",
  "button:has-text('다음')",
  "button:has-text('확인')",
  "button:has-text('등록')",
  "button:has-text('완료')",
];

const PUBLISH_LAYER_ROOT_SELECTORS = [
  "[class*='publish_layer']",
  ".publish_layer_footer",
  ".publish_layer",
  "[data-group='popupLayer']",
];

const TITLE_REQUIRED_MARKERS = [
  "제목을 입력해주세요",
  "제목을 입력해 주세요",
  "제목을 입력",
  "제목을 작성",
];

const CONTENT_REQUIRED_MARKERS = [
  "본문을 입력",
  "내용을 입력",
  "내용을 작성",
  "본문을 작성",
];

const EDITOR_LOADING_MARKERS = [
  "글을 불러오고 있습니다",
  "불러오고 있습니다",
  "작성 중인 글을 불러오고 있습니다",
];

const TITLE_VERIFY_SELECTORS = TITLE_SELECTORS.slice(0, 6);

const POPUP_CLOSE_SELECTORS = [
  "button:has-text('닫기')",
  "button:has-text('나중에')",
  "button:has-text('취소')",
  "button[aria-label='닫기']",
  ".se-help-panel-close-button",
  ".se-popup-close-button",
];

const DRAFT_POPUP_ROOT_SELECTORS = [
  "[data-group='popupLayer']",
  ".se-popup-alert",
  ".se-popup",
];

const DRAFT_RESUME_MARKERS = [
  "작성 중인 글이 있습니다",
  "이어서 작성하시겠습니까",
  "작성중인 글이 있습니다",
];

const BLOCKING_CAPTCHA_SELECTORS = [
  "input[name='captcha']",
  "input#captcha",
  "img[alt*='캡차']",
  "img[alt*='보안문자']",
  "text=자동입력 방지문자",
  "text=보안문자",
];

const CONFIRM_BUTTON_TEXTS = ["공개 발행", "다음", "확인", "등록", "완료"];
const IMAGE_MARKER_REGEX = /\[IMAGE_(\d+)\]/g;
const IMAGE_MARKER_TOKEN_REGEX = /\[IMAGE_\d+\]/g;

let isPublishInFlight = false;

// Browser reuse optimization
let globalBrowser: Browser | null = null;
let globalBrowserLastError: Error | null = null;
const BROWSER_REUSE_ENABLED = (process.env.NAVER_BROWSER_REUSE !== "false");

function nowToken() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mi = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function ensureRuntimeDirs() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(TRACE_DIR, { recursive: true });
}

function stripAnsi(text: string) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function getSafeErrorText(error: any) {
  if (!error) return "";
  if (typeof error === "string") return stripAnsi(error);
  if (typeof error?.message === "string") return stripAnsi(error.message);
  try {
    return stripAnsi(JSON.stringify(error));
  } catch {
    return stripAnsi(String(error));
  }
}

function toUserFacingMessage(error: any) {
  const text = getSafeErrorText(error).toLowerCase();
  if (text.includes("se-popup-dim") || text.includes("intercepts pointer events")) {
    return "네이버 임시저장 팝업이 입력을 막아 실패했습니다. 다시 실행하면 자동으로 팝업부터 정리합니다.";
  }
  if (text.includes("timeout") && text.includes("locator")) {
    return "네이버 로그인 화면이 느려서 자동 입력이 실패했습니다. 다시 눌러주세요.";
  }
  if (text.includes("captcha")) {
    return "캡차가 떠서 자동 진행이 멈췄습니다. 직접 입력 후 다시 눌러주세요.";
  }
  if (text.includes("net::") || text.includes("navigation")) {
    return "네이버 접속이 잠깐 불안정합니다. 잠시 후 다시 시도해주세요.";
  }
  return "네이버 자동 발행 중 오류가 발생했습니다. 다시 시도해주세요.";
}

function getLoginMode(): "manual" | "auto" | "hybrid" {
  const raw = (process.env.NAVER_LOGIN_MODE || "manual").toLowerCase().trim();
  if (raw === "auto" || raw === "hybrid" || raw === "manual") return raw;
  return "manual";
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getMaxPublishAttempts() {
  const raw = Number(process.env.NAVER_PUBLISH_MAX_ATTEMPTS || "3");
  return Math.max(1, Math.min(5, Number.isFinite(raw) ? raw : 3));
}

function isRetryableReason(reason: ReasonCode) {
  return [
    "POST_FAIL",
    "TIMEOUT",
    "UNKNOWN",
    "NAVER_SESSION_INVALID",
    "NAVER_SESSION_PROBE_TIMEOUT",
    "NAVER_SESSION_MISSING",
  ].includes(reason);
}

function loadCredentials(): Credentials {
  const username = (process.env.NAVER_USERNAME || "").trim();
  const password = (process.env.NAVER_PASSWORD || "").trim();
  const blogId = (process.env.NAVER_BLOG_ID || "").trim();

  if (!username || !password || !blogId) {
    throw new Error("네이버 계정 정보가 없습니다. .env.local 또는 NAVER_* 환경변수를 확인해주세요.");
  }

  return { username, password, blogId };
}

function composeUrl(blogId: string) {
  return `https://blog.naver.com/PostWriteForm.naver?blogId=${encodeURIComponent(blogId)}`;
}

function isComposeWriteUrl(url: string) {
  const lower = url.toLowerCase();
  return lower.includes("postwriteform.naver") || lower.includes("postwrite");
}

function mimeTypeToExt(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "jpg";
}

function decodeBase64ImageToFile(base64DataUrl: string, requestToken: string, index: number) {
  const match = base64DataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return "";

  const [, mimeType, rawBase64] = match;
  const ext = mimeTypeToExt(mimeType);
  const filePath = path.join(UPLOAD_DIR, `publish_${requestToken}_${index + 1}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(rawBase64, "base64"));
  return filePath;
}

function normalizeImageForUpload(originalPath: string, requestToken: string, index: number) {
  if (!originalPath || !fs.existsSync(originalPath)) return "";
  if (!fs.existsSync("/usr/bin/sips")) return originalPath;

  const jpgPath = path.join(UPLOAD_DIR, `publish_${requestToken}_${index + 1}_normalized.jpg`);
  const result = spawnSync("/usr/bin/sips", ["-s", "format", "jpeg", originalPath, "--out", jpgPath], {
    encoding: "utf8",
  });

  if (result.status === 0 && fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 0) {
    try {
      fs.unlinkSync(originalPath);
    } catch {
      // ignore
    }
    return jpgPath;
  }

  return originalPath;
}

function prepareImageFiles(base64Images: string[]) {
  if (!Array.isArray(base64Images) || base64Images.length === 0) return [];
  const token = nowToken();
  return base64Images
    .map((image, index) => {
      const filePath = decodeBase64ImageToFile(image, token, index);
      if (!filePath) return "";
      return normalizeImageForUpload(filePath, token, index);
    })
    .filter(Boolean);
}

function cleanupTempFiles(files: string[]) {
  for (const file of files) {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

function isSessionStateAvailable() {
  return fs.existsSync(SESSION_FILE);
}

function getBrowserExecutablePath() {
  const explicitPath = process.env.BROWSER_EXECUTABLE_PATH || process.env.AUTO_POST_CHROME_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;

  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(macChrome)) return macChrome;

  return "";
}

async function launchBrowser(headless: boolean): Promise<Browser> {
  const executablePath = getBrowserExecutablePath();
  if (!executablePath) {
    throw new Error("Chrome 실행 파일을 찾지 못했습니다. BROWSER_EXECUTABLE_PATH를 설정해주세요.");
  }

  return chromium.launch({
    headless,
    executablePath,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

async function isBrowserHealthy(browser: Browser | null): Promise<boolean> {
  if (!browser) return false;
  try {
    // Check if browser is still running
    const version = await browser.version();
    return !!version;
  } catch {
    return false;
  }
}

async function getOrLaunchBrowser(headless: boolean): Promise<Browser> {
  // If reuse disabled, always create new browser
  if (!BROWSER_REUSE_ENABLED) {
    return launchBrowser(headless);
  }

  // Check if global browser is still healthy
  if (await isBrowserHealthy(globalBrowser)) {
    globalBrowserLastError = null;
    return globalBrowser!;
  }

  // Browser is dead or doesn't exist, clean up and launch new one
  try {
    await globalBrowser?.close().catch(() => {});
  } catch {
    // ignore
  }
  globalBrowser = null;

  console.log("[naverPublisher] Launching new browser instance (reuse optimization)");
  globalBrowser = await launchBrowser(headless);
  globalBrowserLastError = null;
  return globalBrowser;
}

export function closeGlobalBrowser() {
  if (globalBrowser) {
    globalBrowser.close().catch((e) => console.error("[naverPublisher] Error closing global browser:", e));
    globalBrowser = null;
  }
}

async function createContext(browser: Browser): Promise<BrowserContext> {
  if (isSessionStateAvailable()) {
    return browser.newContext({ storageState: SESSION_FILE, viewport: { width: 1440, height: 900 } });
  }
  return browser.newContext({ viewport: { width: 1440, height: 900 } });
}

async function maybeVisible(locator: Locator, timeout = 350) {
  try {
    return await locator.first().isVisible({ timeout });
  } catch {
    return false;
  }
}

async function clickIfVisible(root: Page | Frame, selector: string, timeout = 800) {
  const locator = root.locator(selector).first();
  if (await maybeVisible(locator, 300)) {
    try {
      await locator.click({ timeout });
      return true;
    } catch {
      try {
        await locator.click({ timeout, force: true });
        return true;
      } catch {
        try {
          await locator.evaluate((el) => {
            (el as HTMLElement).click();
          });
          return true;
        } catch {
          return false;
        }
      }
    }
  }
  return false;
}

async function hasResumeDraftPopup(page: Page) {
  return containsAnyMarkerTextAcrossFrames(page, DRAFT_RESUME_MARKERS);
}

async function clickCenteredModalButtonByLabels(page: Page, labels: string[]) {
  try {
    return await page.evaluate((inputLabels: string[]) => {
      const normalized = inputLabels.map((label) => label.trim()).filter(Boolean);
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;

      const candidates = Array.from(document.querySelectorAll("button, a, [role='button']")) as HTMLElement[];
      const visible = candidates.filter((el) => {
        const text = (el.innerText || el.textContent || "").trim();
        if (!normalized.some((label) => text.includes(label))) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return true;
      });

      if (!visible.length) return false;

      const centered = visible
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const distance = Math.abs(x - centerX) + Math.abs(y - centerY);
          return { el, distance };
        })
        .sort((a, b) => a.distance - b.distance);

      const target = centered[0]?.el || visible[0];
      if (!target) return false;
      target.click();
      return true;
    }, labels);
  } catch {
    return false;
  }
}

async function dismissResumeDraftPopup(page: Page) {
  if (!(await hasResumeDraftPopup(page))) return false;

  const preferred = ["취소", "확인"];
  const modalRoots = [
    "[role='dialog']",
    "[aria-modal='true']",
    ".ly_alert",
    ".popup",
    ".layer",
    "[class*='popup']",
    "[class*='layer']",
  ];

  for (const label of preferred) {
    for (const root of modalRoots) {
      const scoped = page.locator(`${root} button, ${root} [role='button'], ${root} a`).filter({ hasText: label });
      const count = Math.min(3, await scoped.count().catch(() => 0));
      for (let i = 0; i < count; i += 1) {
        const button = scoped.nth(i);
        if (!(await maybeVisible(button, 300))) continue;
        await button.click({ timeout: 1200, force: true }).catch(() => {});
        await page.waitForTimeout(180);
        if (!(await hasResumeDraftPopup(page))) return true;
      }
    }
  }

  for (const label of preferred) {
    const roleButton = page.getByRole("button", { name: label }).first();
    if (await maybeVisible(roleButton, 350)) {
      await roleButton.click({ timeout: 1200, force: true }).catch(() => {});
      await page.waitForTimeout(180);
      if (!(await hasResumeDraftPopup(page))) return true;
    }
  }

  for (const labels of [["취소"], ["확인"], ["취소", "확인"]]) {
    if (await clickCenteredModalButtonByLabels(page, labels)) {
      await page.waitForTimeout(180);
      if (!(await hasResumeDraftPopup(page))) return true;
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(160);
  return !(await hasResumeDraftPopup(page));
}

async function dismissBlockingEditorPopup(page: Page) {
  const preferredButtonTexts = ["취소", "나중에", "새로", "닫기", "확인"];
  const popupButtonSelector = DRAFT_POPUP_ROOT_SELECTORS.map((selector) => `${selector} button`).join(", ");

  for (let round = 0; round < 6; round += 1) {
    if (await dismissResumeDraftPopup(page)) {
      await page.waitForTimeout(150);
      continue;
    }

    const dimVisible = await maybeVisible(page.locator(".se-popup-dim").first(), 250);
    let popupFound = dimVisible || (await hasResumeDraftPopup(page));

    if (!popupFound) {
      for (const rootSelector of DRAFT_POPUP_ROOT_SELECTORS) {
        if (await maybeVisible(page.locator(rootSelector).first(), 250)) {
          popupFound = true;
          break;
        }
      }
    }

    if (!popupFound) return;

    let handled = false;

    for (const text of preferredButtonTexts) {
      try {
        const popupButtons = page.locator(popupButtonSelector).filter({ hasText: text });
        const count = await popupButtons.count().catch(() => 0);
        if (count > 0) {
          await popupButtons.first().click({ timeout: 1200, force: true }).catch(() => {});
          handled = true;
          break;
        }
      } catch {
        // ignore
      }
    }

    if (!handled) {
      const anyPopupButton = page.locator(popupButtonSelector).first();
      if (await maybeVisible(anyPopupButton, 300)) {
        await anyPopupButton.click({ timeout: 1000, force: true }).catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
    }

    await page.waitForTimeout(180);
  }
}

async function closePopups(page: Page) {
  await dismissBlockingEditorPopup(page);

  for (let round = 0; round < 4; round += 1) {
    let clicked = false;
    for (const selector of POPUP_CLOSE_SELECTORS) {
      try {
        if (await clickIfVisible(page, selector, 600)) {
          clicked = true;
          await page.waitForTimeout(120);
        }
      } catch {
        // ignore
      }
    }
    if (!clicked) break;
  }

  await dismissBlockingEditorPopup(page);
}

async function installOverlayHandlers(page: Page) {
  try {
    await page.addLocatorHandler(page.getByText("작성 중인 글이 있습니다", { exact: false }).first(), async () => {
      await clickCenteredModalButtonByLabels(page, ["취소", "확인"]);
    });
  } catch {
    // ignore
  }

  try {
    await page.addLocatorHandler(page.getByText("파일 전송 오류", { exact: false }).first(), async () => {
      await clickCenteredModalButtonByLabels(page, ["확인"]);
    });
  } catch {
    // ignore
  }

  try {
    await page.addLocatorHandler(
      page.locator(".se-popup-dim").first(),
      async () => {
        await page.keyboard.press("Escape").catch(() => {});
      },
      { noWaitAfter: true },
    );
  } catch {
    // ignore
  }
}

async function looksLikeLoginPage(page: Page) {
  const url = page.url().toLowerCase();
  if (url.includes("nid.naver.com") || url.includes("nidlogin.login")) return true;

  const loginSelectors = [
    "input#id",
    "input#pw",
    "button[type='submit']",
    "text=로그인",
  ];

  for (const selector of loginSelectors) {
    if (await maybeVisible(page.locator(selector), 250)) return true;
  }
  return false;
}

async function detectCaptcha(page: Page) {
  const url = page.url().toLowerCase();
  if (url.includes("captcha")) return true;

  for (const selector of BLOCKING_CAPTCHA_SELECTORS) {
    if (await maybeVisible(page.locator(selector), 250)) return true;
  }
  return false;
}

function isWrongBlogTarget(currentUrl: string, blogId: string) {
  if (!currentUrl.includes("blog.naver.com")) return false;
  const normalizedUrl = currentUrl.toLowerCase();
  const normalizedBlogId = blogId.toLowerCase();
  return !normalizedUrl.includes(`blogid=${normalizedBlogId}`) && !normalizedUrl.includes(`blog.naver.com/${normalizedBlogId}`);
}

async function hasComposeAccess(page: Page, blogId: string) {
  if (await looksLikeLoginPage(page)) {
    return { ok: false, reason: "NAVER_LOGIN_REQUIRED" as ReasonCode };
  }

  if (isWrongBlogTarget(page.url(), blogId)) {
    return { ok: false, reason: "NAVER_WRONG_BLOG_TARGET" as ReasonCode };
  }

  await closePopups(page);

  for (const selector of TITLE_SELECTORS) {
    if (await maybeVisible(page.locator(selector), 1200)) {
      return { ok: true, reason: "OK" as ReasonCode };
    }
  }

  return { ok: false, reason: "NAVER_SESSION_INVALID" as ReasonCode };
}

async function attemptAutoLogin(page: Page, credentials: Credentials) {
  const idField = page.locator("input#id").first();
  const pwField = page.locator("input#pw").first();
  const submitButton = page.locator("button[type='submit'], button:has-text('로그인')").first();

  if (!(await maybeVisible(idField, 1000)) || !(await maybeVisible(pwField, 1000))) {
    return false;
  }

  const safeFill = async (locator: Locator, value: string) => {
    try {
      await locator.fill(value, { timeout: 2500 });
      return true;
    } catch {
      try {
        await locator.evaluate((el, v) => {
          const input = el as HTMLInputElement;
          input.value = v;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, value);
        return true;
      } catch {
        return false;
      }
    }
  };

  const idOk = await safeFill(idField, credentials.username);
  const pwOk = await safeFill(pwField, credentials.password);
  if (!idOk || !pwOk) return false;

  if (await maybeVisible(submitButton, 500)) {
    await submitButton.click({ timeout: 2500 }).catch(() => {});
  } else {
    await page.keyboard.press("Enter");
  }

  await page.waitForTimeout(1200);
  return true;
}

async function saveFailureScreenshot(page: Page, reason: ReasonCode) {
  ensureRuntimeDirs();
  const screenshotPath = path.join(SCREENSHOT_DIR, `FAIL_NAVER_${reason}_${nowToken()}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch {
    return "";
  }
}

function getFailureTracePath(reason: ReasonCode, attempt: number) {
  ensureRuntimeDirs();
  return path.join(TRACE_DIR, `TRACE_NAVER_${reason}_A${attempt}_${nowToken()}.zip`);
}

async function ensureComposeReady(
  page: Page,
  credentials: Credentials,
): Promise<{ ok: boolean; reason: ReasonCode; screenshotPath?: string }> {
  const composeTarget = composeUrl(credentials.blogId);
  await page.goto(composeTarget, { waitUntil: "domcontentloaded", timeout: 45_000 });

  let probe = await hasComposeAccess(page, credentials.blogId);
  if (probe.ok) {
    return { ok: true, reason: "OK" };
  }

  let autoLoginDone = false;
  const loginMode = getLoginMode();
  const timeoutSec = Number(process.env.NAVER_SESSION_REFRESH_TIMEOUT_SEC || "300");
  const timeoutAt = Date.now() + timeoutSec * 1000;
  let sawCaptcha = false;
  let lastReason: ReasonCode = probe.reason;
  let nextComposeRetryAt = 0;

  while (Date.now() < timeoutAt) {
    if (await detectCaptcha(page)) {
      sawCaptcha = true;
    }

    const onLoginPage = await looksLikeLoginPage(page);
    if (onLoginPage) {
      lastReason = sawCaptcha ? "NAVER_CAPTCHA_REQUIRED" : "NAVER_LOGIN_REQUIRED";
      if ((loginMode === "auto" || loginMode === "hybrid") && !autoLoginDone) {
        autoLoginDone = await attemptAutoLogin(page, credentials);
      }
      await page.waitForTimeout(1200);
      continue;
    }

    probe = await hasComposeAccess(page, credentials.blogId);
    lastReason = probe.reason;
    if (probe.ok) {
      return { ok: true, reason: "OK" };
    }

    const currentUrl = page.url();
    const shouldRetryComposeOpen =
      (!isComposeWriteUrl(currentUrl) || probe.reason === "NAVER_WRONG_BLOG_TARGET") &&
      Date.now() >= nextComposeRetryAt;

    if (shouldRetryComposeOpen) {
      await page.goto(composeTarget, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      nextComposeRetryAt = Date.now() + 3500;
    }

    await page.waitForTimeout(1000);
  }

  const reason =
    sawCaptcha
      ? "NAVER_CAPTCHA_REQUIRED"
      : lastReason === "NAVER_LOGIN_REQUIRED"
        ? "NAVER_LOGIN_REQUIRED"
        : "NAVER_SESSION_PROBE_TIMEOUT";
  const screenshotPath = await saveFailureScreenshot(page, reason);
  return { ok: false, reason, screenshotPath };
}

async function clearAndType(page: Page, locator: Locator, value: string) {
  await dismissBlockingEditorPopup(page);

  try {
    await locator.click({ timeout: 1200 });
  } catch {
    await dismissBlockingEditorPopup(page);
    await locator.click({ timeout: 1200, force: true }).catch(() => {});
  }
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});

  try {
    await locator.fill(value, { timeout: 1200 });
    return true;
  } catch {
    try {
      await page.keyboard.insertText(value);
      return true;
    } catch {
      return false;
    }
  }
}

async function getLocatorText(locator: Locator) {
  try {
    const value = await locator.inputValue({ timeout: 300 }).catch(() => "");
    if (value?.trim()) return value.trim();
  } catch {
    // ignore
  }

  try {
    const text = await locator.innerText({ timeout: 300 });
    if (text?.trim()) return text.trim();
  } catch {
    // ignore
  }

  try {
    const text = await locator.evaluate((el) => ((el as HTMLElement).textContent || "").trim());
    if (text?.trim()) return text.trim();
  } catch {
    // ignore
  }

  return "";
}

async function fillTitle(page: Page, title: string) {
  const titleNeedle = title.trim().slice(0, 6);
  for (const selector of TITLE_SELECTORS) {
    const locator = page.locator(selector).first();
    if (await maybeVisible(locator, 700)) {
      const ok = await clearAndType(page, locator, title);
      if (!ok) continue;
      await page.waitForTimeout(150);
      const afterText = await getLocatorText(locator);
      if (afterText.includes(titleNeedle) || afterText.length >= Math.min(4, title.length)) {
        return true;
      }
    }
  }
  return false;
}

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

  return normalized;
}

function sanitizeContent(rawContent: string) {
  return normalizeEscapedLineBreaks(rawContent)
    .replace(IMAGE_MARKER_TOKEN_REGEX, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeParagraphText(paragraph: string) {
  return paragraph
    .replace(/\t+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSingleParagraphForImageBoundaries(paragraph: string) {
  const normalized = normalizeParagraphText(paragraph);
  if (!normalized) return [];

  const sentences =
    normalized
      .match(/[^.!?。！？]+[.!?。！？]?/g)
      ?.map((item) => item.trim())
      .filter(Boolean) || [];

  if (sentences.length >= 2) {
    const midpoint = Math.ceil(sentences.length / 2);
    return [
      sentences.slice(0, midpoint).join(" ").trim(),
      sentences.slice(midpoint).join(" ").trim(),
    ].filter(Boolean);
  }

  const midpoint = Math.floor(normalized.length / 2);
  if (midpoint <= 0 || midpoint >= normalized.length - 1) return [normalized];

  let splitAt = normalized.lastIndexOf(" ", midpoint);
  if (splitAt < Math.floor(normalized.length * 0.25)) {
    splitAt = normalized.indexOf(" ", midpoint);
  }
  if (splitAt <= 0 || splitAt >= normalized.length - 1) {
    splitAt = midpoint;
  }

  const first = normalized.slice(0, splitAt).trim();
  const second = normalized.slice(splitAt).trim();
  return [first, second].filter(Boolean);
}

function buildParagraphImagePlan(rawContent: string, imageCount: number): ParagraphImagePlan {
  const normalized = normalizeEscapedLineBreaks(rawContent).replace(/\n{3,}/g, "\n\n").trim();
  const rawParagraphs = normalized
    ? normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
    : [];

  const paragraphs: string[] = [];
  const imageMarkersByAnchorParagraph = new Map<number, number[]>();
  const imageIndexesBeforeFirstParagraph: number[] = [];
  const markerOrder: number[] = [];

  const addAnchorMarkers = (anchorParagraphIndex: number, indexes: number[]) => {
    if (!indexes.length) return;
    const existing = imageMarkersByAnchorParagraph.get(anchorParagraphIndex) || [];
    existing.push(...indexes);
    imageMarkersByAnchorParagraph.set(anchorParagraphIndex, existing);
  };

  const addMarkerOrder = (index: number) => {
    if (index < 0 || index >= imageCount) return;
    if (!markerOrder.includes(index)) markerOrder.push(index);
  };

  const addLeadingMarker = (index: number) => {
    if (index < 0 || index >= imageCount) return;
    if (!imageIndexesBeforeFirstParagraph.includes(index)) {
      imageIndexesBeforeFirstParagraph.push(index);
    }
  };

  let textParagraphCount = 0;

  for (const rawParagraph of rawParagraphs) {
    const markerIndexes = Array.from(rawParagraph.matchAll(IMAGE_MARKER_REGEX))
      .map((match) => Number.parseInt(match[1], 10) - 1)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < imageCount);

    markerIndexes.forEach(addMarkerOrder);

    const cleanedParagraph = normalizeParagraphText(rawParagraph.replace(IMAGE_MARKER_TOKEN_REGEX, " "));
    if (cleanedParagraph) {
      paragraphs.push(cleanedParagraph);
      const anchorParagraphIndex = textParagraphCount;
      textParagraphCount += 1;
      addAnchorMarkers(anchorParagraphIndex, markerIndexes);
      continue;
    }

    if (markerIndexes.length) {
      if (textParagraphCount === 0) {
        markerIndexes.forEach(addLeadingMarker);
      } else {
        const anchorParagraphIndex = Math.max(0, textParagraphCount - 1);
        addAnchorMarkers(anchorParagraphIndex, markerIndexes);
      }
    }
  }

  if (paragraphs.length === 0) {
    const fallbackText = sanitizeContent(rawContent);
    if (fallbackText) {
      paragraphs.push(
        ...fallbackText
          .split(/\n{2,}/)
          .map((item) => normalizeParagraphText(item))
          .filter(Boolean),
      );
    }
  }

  if (imageCount > 0 && paragraphs.length < 2 && paragraphs.length > 0) {
    const splitParagraphs = splitSingleParagraphForImageBoundaries(paragraphs[0]);
    if (splitParagraphs.length >= 2) {
      paragraphs.splice(0, 1, ...splitParagraphs);
    }
  }

  const boundaryCount = Math.max(0, paragraphs.length - 1);
  const imageGroupsByBoundary = Array.from({ length: boundaryCount }, () => [] as number[]);
  const assignedImageIndexes = new Set<number>();

  for (const imageIndex of imageIndexesBeforeFirstParagraph) {
    assignedImageIndexes.add(imageIndex);
  }

  if (boundaryCount > 0) {
    for (const [anchorParagraphIndex, indexes] of imageMarkersByAnchorParagraph.entries()) {
      const boundaryIndex = Math.max(0, Math.min(boundaryCount - 1, anchorParagraphIndex));
      for (const imageIndex of indexes) {
        if (assignedImageIndexes.has(imageIndex)) continue;
        imageGroupsByBoundary[boundaryIndex].push(imageIndex);
        assignedImageIndexes.add(imageIndex);
      }
    }
  }

  const orderedImageIndexes: number[] = [];
  for (const imageIndex of markerOrder) {
    if (!orderedImageIndexes.includes(imageIndex)) orderedImageIndexes.push(imageIndex);
  }
  for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
    if (!orderedImageIndexes.includes(imageIndex)) orderedImageIndexes.push(imageIndex);
  }

  const remainingImageIndexes = orderedImageIndexes.filter((imageIndex) => !assignedImageIndexes.has(imageIndex));
  if (boundaryCount > 0) {
    for (let i = 0; i < remainingImageIndexes.length; i += 1) {
      const boundaryIndex = i % boundaryCount;
      imageGroupsByBoundary[boundaryIndex].push(remainingImageIndexes[i]);
      assignedImageIndexes.add(remainingImageIndexes[i]);
    }
  }

  const hasPlacementSlots = boundaryCount > 0 || imageIndexesBeforeFirstParagraph.length > 0;
  const canPlaceImagesBetweenParagraphs =
    imageCount === 0 || (hasPlacementSlots && assignedImageIndexes.size >= imageCount);

  return {
    paragraphs,
    imageGroupsByBoundary,
    imageIndexesBeforeFirstParagraph,
    expectedText: paragraphs.join("\n\n"),
    canPlaceImagesBetweenParagraphs,
  };
}

function normalizeComparableText(text: string) {
  return text.replace(/\s+/g, "").trim();
}

async function isLikelyTitleLocator(locator: Locator) {
  try {
    return await locator.evaluate((el) => {
      const element = el as HTMLElement;
      const attrText =
        `${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""} ${element.getAttribute("data-placeholder") || ""}`.toLowerCase();
      if (attrText.includes("제목") || attrText.includes("title")) return true;
      if (element.closest(".se-section-documentTitle")) return true;
      return false;
    });
  } catch {
    return false;
  }
}

async function pickVisibleContentLocator(root: Page | Frame) {
  const selectors = [
    ".se-main-container .se-section-text .se-module-text",
    ".se-main-container .se-text-paragraph",
    ".se-main-container [contenteditable='true']",
    ".se-section-text [contenteditable='true']",
    ...CONTENT_FOCUS_SELECTORS,
  ];

  for (const selector of selectors) {
    const matches = root.locator(selector);
    const count = Math.min(6, await matches.count().catch(() => 0));
    for (let i = count - 1; i >= 0; i -= 1) {
      const candidate = matches.nth(i);
      if (!(await maybeVisible(candidate, 600))) continue;
      if (await isLikelyTitleLocator(candidate)) continue;
      return candidate;
    }
  }

  return null;
}

async function focusContentEditorLocator(page: Page): Promise<Locator | null> {
  await closePopups(page);

  const inMain = await pickVisibleContentLocator(page);
  if (inMain) {
    await inMain.click({ timeout: 1200 }).catch(() => inMain.click({ timeout: 1200, force: true }));
    return inMain;
  }

  for (const frame of page.frames()) {
    const inFrame = await pickVisibleContentLocator(frame);
    if (!inFrame) continue;
    await inFrame.click({ timeout: 1200 }).catch(() => inFrame.click({ timeout: 1200, force: true }));
    return inFrame;
  }

  return null;
}

async function focusContentEditor(page: Page) {
  return Boolean(await focusContentEditorLocator(page));
}

async function readEditorTextFromRoot(root: Page | Frame) {
  try {
    return await root.evaluate((selectors: string[]) => {
      let best = "";

      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          const text = (node.textContent || "").trim();
          if (text.length > best.length) best = text;
        }
      }

      if (!best) {
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.isContentEditable || active.tagName === "TEXTAREA")) {
          const activeText = (active.textContent || (active as HTMLTextAreaElement).value || "").trim();
          if (activeText.length > best.length) best = activeText;
        }
      }

      return best;
    }, CONTENT_VERIFY_SELECTORS);
  } catch {
    return "";
  }
}

async function getEditorCombinedText(page: Page) {
  let best = await readEditorTextFromRoot(page);

  for (const frame of page.frames()) {
    const frameText = await readEditorTextFromRoot(frame);
    if (normalizeComparableText(frameText).length > normalizeComparableText(best).length) {
      best = frameText;
    }
  }

  return best;
}

async function getEditorTextLength(page: Page) {
  const text = await getEditorCombinedText(page);
  return normalizeComparableText(text).length;
}

async function hasEditorContentSignals(page: Page) {
  const signals = [
    ".se-main-container .se-section-text",
    ".se-main-container .se-text-paragraph",
    ".se-main-container .se-module-text",
    ".se-main-container .se-component",
  ];

  const countByRoot = async (root: Page | Frame) => {
    let maxCount = 0;
    for (const selector of signals) {
      const count = await root.locator(selector).count().catch(() => 0);
      if (count > maxCount) maxCount = count;
    }
    return maxCount;
  };

  let bestCount = await countByRoot(page);
  for (const frame of page.frames()) {
    const frameCount = await countByRoot(frame);
    if (frameCount > bestCount) bestCount = frameCount;
  }

  return bestCount >= 2;
}

async function moveCaretToEditorEnd(page: Page) {
  await page.keyboard.press("Meta+ArrowDown").catch(() => {});
  await page.keyboard.press("Control+End").catch(() => {});
  await page.keyboard.press("End").catch(() => {});
  await page.waitForTimeout(40);
}

async function insertParagraphGap(page: Page) {
  await page.keyboard.press("Enter").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(70);
}

function sanitizeSubtitleText(text: string, sectionIndex: number) {
  const normalized = sanitizeContent(text)
    .replace(/^#+\s*/, "")
    .replace(/^■\s*/, "")
    .replace(/\s*■$/, "")
    .replace(/^소제목[:：]?\s*/i, "")
    .trim();
  return normalized || `소제목 ${sectionIndex + 1}`;
}

function normalizeBodyTextForSection(text: string) {
  const normalized = sanitizeContent(text).replace(/\s+/g, " ").trim();
  const PREFERRED_MAX = 120;
  const HARD_MAX = 150;
  let limited = normalized;
  if (normalized.length > PREFERRED_MAX) {
    const tailWindow = normalized.slice(PREFERRED_MAX, HARD_MAX + 1);
    const sentenceEndOffset = tailWindow.search(/[.!?。！？]/);
    if (sentenceEndOffset >= 0) {
      limited = normalized.slice(0, PREFERRED_MAX + sentenceEndOffset + 1).trim();
    } else {
      limited = normalized.slice(0, HARD_MAX).trim();
    }
  }
  const paddingPool = [
    " 오늘의 공기가 한층 더 포근하게 느껴졌다.",
    " 작은 장면 하나가 오래 마음에 남았다.",
    " 익숙한 풍경도 새롭게 보이는 순간이었다.",
  ];
  let paddingIndex = 0;
  while (limited.length < 80 && paddingIndex < 10) {
    const pad = paddingPool[paddingIndex % paddingPool.length];
    const available = PREFERRED_MAX - limited.length;
    if (available <= 0) break;
    limited = `${limited}${pad.slice(0, available)}`.trim();
    paddingIndex += 1;
  }
  return limited
    .replace(/([.!?。！？])\s*/g, "$1\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeSectionsForImageCount(request: PublishRequest, imageCount: number) {
  const sourceSections = Array.isArray(request.sections) ? request.sections : [];
  const normalized = sourceSections.map((section, index) => {
    const subtitle = sanitizeSubtitleText(typeof section?.subtitle === "string" ? section.subtitle : "", index);
    const rawBody = typeof section?.body === "string" ? section.body : "";
    const body = normalizeBodyTextForSection(rawBody || `${subtitle}의 장면을 중심으로 오늘의 분위기를 정리합니다.`);
    const rawKeywords = Array.isArray(section?.keywords) ? section.keywords : [];
    const keywords = rawKeywords
      .map((keyword) => sanitizeContent(String(keyword || "")).trim())
      .filter(Boolean)
      .slice(0, 3);
    const fallbackKeywords = ["분위기", "감성", "기록"];
    for (const fallback of fallbackKeywords) {
      if (keywords.length >= 2) break;
      if (!keywords.includes(fallback)) keywords.push(fallback);
    }
    return { subtitle, body, keywords };
  });

  if (normalized.length >= imageCount) return normalized.slice(0, imageCount);

  const filled = [...normalized];
  while (filled.length < imageCount) {
    const idx = filled.length;
    const subtitle = `소제목 ${idx + 1}`;
    filled.push({
      subtitle,
      body: normalizeBodyTextForSection("사진의 분위기와 장면을 중심으로 오늘의 감정을 기록합니다."),
      keywords: ["분위기", "감성", "기록"],
    });
  }

  return filled;
}

async function applyStyleToLatestTextBlock(
  page: Page,
  style: {
    textAlign?: "left" | "center" | "right";
    fontWeight?: string;
    fontSize?: string;
    wordBreak?: string;
    overflowWrap?: string;
  },
) {
  const applyInRoot = async (root: Page | Frame) => {
    try {
      return await root.evaluate((targetStyle) => {
        const selectors = [
          ".se-main-container .se-section-text .se-module-text",
          ".se-main-container .se-text-paragraph",
          ".se-section-text .se-module-text",
          ".se-text-paragraph",
          ".se-module-text",
          "p",
        ];

        const candidates: HTMLElement[] = [];
        const visited = new Set<HTMLElement>();
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          for (const node of nodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (visited.has(node)) continue;
            visited.add(node);
            candidates.push(node);
          }
        }

        const visible = candidates.filter((el) => {
          const rect = el.getBoundingClientRect();
          const css = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility !== "hidden";
        });

        const target = visible[visible.length - 1] || candidates[candidates.length - 1];
        if (!target) return false;

        if (targetStyle.textAlign) target.style.textAlign = targetStyle.textAlign;
        if (targetStyle.fontWeight) target.style.fontWeight = targetStyle.fontWeight;
        if (targetStyle.fontSize) target.style.fontSize = targetStyle.fontSize;
        if (targetStyle.wordBreak) target.style.wordBreak = targetStyle.wordBreak;
        if (targetStyle.overflowWrap) target.style.overflowWrap = targetStyle.overflowWrap;
        return true;
      }, style);
    } catch {
      return false;
    }
  };

  if (await applyInRoot(page)) return true;
  for (const frame of page.frames()) {
    if (await applyInRoot(frame)) return true;
  }
  return false;
}

function parseQuoteAndPhilosopher(rawQuote: string) {
  const cleaned = sanitizeContent(rawQuote).replace(/^[;；\s]+|[;；\s]+$/g, "").trim();
  if (!cleaned) {
    return { quote: "오늘의 순간을 기록하는 마음으로 하루를 담아봅니다.", philosopher: "작자 미상" };
  }

  const normalizedForTwoLines = cleaned.replace(
    /(["'”])\s*[—-]\s*([^—-]+?)\s*[—-]\s*$/u,
    "$1\n- $2 -",
  );

  const lines = normalizedForTwoLines.split("\n").map((line) => line.trim()).filter(Boolean);
  const lineWithPhilosopher = lines.find((line) => /[—-].+[—-]/.test(line)) || "";
  const nameMatch = lineWithPhilosopher.match(/[—-]\s*([^—-]+?)\s*[—-]/);
  const philosopher = (nameMatch?.[1] || "").trim() || "작자 미상";

  let quote = lines.find((line) => line !== lineWithPhilosopher) || normalizedForTwoLines;
  quote = quote.replace(/[—-]\s*[^—-]+?\s*[—-]/g, "").trim();
  quote = quote.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!quote) quote = "오늘의 순간을 기록하는 마음으로 하루를 담아봅니다.";

  return { quote, philosopher };
}

async function highlightKeywordsInLatestTextBlocks(page: Page, keywords: string[], recentBlockCount: number) {
  const usableKeywords = Array.from(
    new Set(
      keywords
        .map((keyword) => sanitizeContent(keyword).trim())
        .filter((keyword) => keyword.length > 0),
    ),
  ).slice(0, 3);

  if (usableKeywords.length === 0) return true;

  const applyInRoot = async (root: Page | Frame) => {
    try {
      return await root.evaluate(
        ({ selectedKeywords, blockCount }) => {
          const selectors = [
            ".se-main-container .se-section-text .se-module-text",
            ".se-main-container .se-text-paragraph",
            ".se-section-text .se-module-text",
            ".se-text-paragraph",
            ".se-module-text",
            "p",
          ];

          const candidates: HTMLElement[] = [];
          const visited = new Set<HTMLElement>();
          for (const selector of selectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              if (visited.has(node)) continue;
              visited.add(node);
              candidates.push(node);
            }
          }

          const visible = candidates.filter((el) => {
            const rect = el.getBoundingClientRect();
            const css = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility !== "hidden";
          });

          const targetBlocks = visible.slice(Math.max(0, visible.length - Math.max(1, blockCount)));
          if (!targetBlocks.length) return false;

          const highlightOneKeyword = (container: HTMLElement, keyword: string, color: string) => {
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
            const textNodes: Text[] = [];
            let current = walker.nextNode();
            while (current) {
              if (current.nodeType === Node.TEXT_NODE) {
                const textNode = current as Text;
                if ((textNode.nodeValue || "").trim()) textNodes.push(textNode);
              }
              current = walker.nextNode();
            }

            for (const textNode of textNodes) {
              const source = textNode.nodeValue || "";
              const index = source.indexOf(keyword);
              if (index < 0) continue;

              const before = source.slice(0, index);
              const matched = source.slice(index, index + keyword.length);
              const after = source.slice(index + keyword.length);

              const fragment = document.createDocumentFragment();
              if (before) fragment.appendChild(document.createTextNode(before));

              const marker = document.createElement("span");
              marker.style.backgroundColor = color;
              marker.textContent = matched;
              fragment.appendChild(marker);

              if (after) fragment.appendChild(document.createTextNode(after));
              textNode.parentNode?.replaceChild(fragment, textNode);
              return true;
            }

            return false;
          };

          const highlightColors = ["#FFF176", "#A5D6A7", "#81D4FA"];

          for (let keywordIndex = 0; keywordIndex < selectedKeywords.length; keywordIndex += 1) {
            const keyword = selectedKeywords[keywordIndex];
            const color = highlightColors[keywordIndex % highlightColors.length];

            for (const block of targetBlocks) {
              if (highlightOneKeyword(block, keyword, color)) break;
            }
          }

          return true;
        },
        { selectedKeywords: usableKeywords, blockCount: recentBlockCount },
      );
    } catch {
      return false;
    }
  };

  if (await applyInRoot(page)) return true;
  for (const frame of page.frames()) {
    if (await applyInRoot(frame)) return true;
  }
  return false;
}

async function insertFormattedSubtitle(page: Page, subtitle: string) {
  await moveCaretToEditorEnd(page);
  await page.keyboard.insertText(`■ ${subtitle} ■`);
  await page.waitForTimeout(50);
  await applyStyleToLatestTextBlock(page, {
    textAlign: "center",
    fontWeight: "700",
    fontSize: "133%",
    wordBreak: "keep-all",
    overflowWrap: "break-word",
  });
}

async function insertFormattedBody(page: Page, body: string, keywords: string[]) {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const chunks = lines.length ? lines : ["사진의 장면을 중심으로 오늘의 감정을 기록합니다."];
  for (let i = 0; i < chunks.length; i += 1) {
    await moveCaretToEditorEnd(page);
    await page.keyboard.insertText(chunks[i]);
    await page.waitForTimeout(40);
    await applyStyleToLatestTextBlock(page, {
      textAlign: "center",
      wordBreak: "keep-all",
      overflowWrap: "break-word",
    });
    if (i < chunks.length - 1) {
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(60);
    }
  }

  await highlightKeywordsInLatestTextBlocks(page, keywords, chunks.length).catch(() => {});
  return chunks.length;
}

function normalizeHashtags(tags: string[]) {
  const cleaned = tags
    .map((tag) => tag.replace(/^#+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const unique = Array.from(new Set(cleaned));
  return unique.slice(0, 9);
}

async function fillContentAndInsertImagesBySectionStructure(page: Page, request: PublishRequest, imagePaths: string[]) {
  if (!imagePaths.length) return false;

  const sections = normalizeSectionsForImageCount(request, imagePaths.length);
  if (sections.length !== imagePaths.length) return false;

  await dismissBlockingEditorPopup(page);
  const contentLocator = await focusContentEditorLocator(page);
  if (!contentLocator) return false;

  await contentLocator.click({ timeout: 800 }).catch(() => contentLocator.click({ timeout: 800, force: true }));
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.waitForTimeout(120);

  let previousCount = await countEditorImages(page);
  let insertedImages = 0;
  const expectedParts: string[] = [];

  const rawQuote = typeof request.quote === "string" ? request.quote : "";
  if (rawQuote.trim()) {
    const quoteSection = parseQuoteAndPhilosopher(rawQuote);

    await moveCaretToEditorEnd(page);
    await page.keyboard.insertText(`"${quoteSection.quote}"`);
    await page.waitForTimeout(60);
    await applyStyleToLatestTextBlock(page, {
      textAlign: "center",
      wordBreak: "keep-all",
      overflowWrap: "break-word",
    });
    expectedParts.push(quoteSection.quote);

    await page.keyboard.press("Enter").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(60);
    await moveCaretToEditorEnd(page);
    await page.keyboard.insertText(`- ${quoteSection.philosopher} -`);
    await page.waitForTimeout(60);
    await applyStyleToLatestTextBlock(page, {
      textAlign: "center",
      wordBreak: "keep-all",
      overflowWrap: "break-word",
    });
    expectedParts.push(quoteSection.philosopher);

    await insertParagraphGap(page);
  }

  for (let i = 0; i < imagePaths.length; i += 1) {
    const imagePath = imagePaths[i];
    const section = sections[i];
    if (!imagePath || !section) return false;

    await moveCaretToEditorEnd(page);
    const currentCount = await uploadImageAtCursorAndVerify(page, imagePath, previousCount);
    if (currentCount < 0) return false;
    previousCount = currentCount;
    insertedImages += 1;

    await insertParagraphGap(page);
    await insertFormattedSubtitle(page, section.subtitle);
    expectedParts.push(section.subtitle);

    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(60);
    await insertFormattedBody(page, section.body, section.keywords || []);
    expectedParts.push(section.body);

    await insertParagraphGap(page);
    await insertParagraphGap(page);
  }

  const hashtagSource = Array.isArray(request.hashtags) ? request.hashtags : [];
  const hashtags = normalizeHashtags(hashtagSource);
  if (hashtags.length > 0) {
    const firstLine = hashtags.slice(0, 5).map((tag) => `#${tag}`).join(" ");
    const secondLine = hashtags.slice(5).map((tag) => `#${tag}`).join(" ");

    await moveCaretToEditorEnd(page);
    await page.keyboard.insertText(firstLine);
    await page.waitForTimeout(40);
    await applyStyleToLatestTextBlock(page, {
      textAlign: "center",
      wordBreak: "keep-all",
      overflowWrap: "break-word",
    });
    expectedParts.push(firstLine);

    if (secondLine) {
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(60);
      await page.keyboard.insertText(secondLine);
      await page.waitForTimeout(40);
      await applyStyleToLatestTextBlock(page, {
        textAlign: "center",
        wordBreak: "keep-all",
        overflowWrap: "break-word",
      });
      expectedParts.push(secondLine);
    }
  }

  if (insertedImages !== imagePaths.length) return false;
  return verifyEditorHasExpectedText(page, expectedParts.join("\n\n"));
}

async function verifyEditorHasExpectedText(page: Page, expectedRawText: string) {
  const expected = normalizeComparableText(expectedRawText);
  if (!expected) return false;

  const observed = normalizeComparableText(await getEditorCombinedText(page));
  const firstNeedle = expected.slice(0, Math.min(10, expected.length));
  const lastNeedle = expected.slice(Math.max(0, expected.length - Math.min(10, expected.length)));
  const markerMatched =
    (firstNeedle.length >= 3 && observed.includes(firstNeedle)) ||
    (lastNeedle.length >= 3 && observed.includes(lastNeedle));
  const minimumLength = Math.max(3, Math.min(60, Math.floor(expected.length * 0.05)));
  if (markerMatched || observed.length >= minimumLength) return true;

  if (await hasEditorContentSignals(page)) {
    const validationIssue = await detectPublishValidationIssue(page);
    return validationIssue !== "CONTENT_REQUIRED";
  }

  const validationIssue = await detectPublishValidationIssue(page);
  return validationIssue !== "CONTENT_REQUIRED";
}

async function fillContent(page: Page, content: string) {
  const cleaned = sanitizeContent(content);
  if (!cleaned) return false;
  await dismissBlockingEditorPopup(page);

  const contentLocator = await focusContentEditorLocator(page);
  if (!contentLocator) {
    const existingLen = await getEditorTextLength(page);
    const minimumLength = Math.max(3, Math.min(80, Math.floor(normalizeComparableText(cleaned).length * 0.05)));
    const hasSignals = await hasEditorContentSignals(page);
    if (existingLen >= minimumLength || hasSignals) {
      const validationIssue = await detectPublishValidationIssue(page);
      return validationIssue !== "CONTENT_REQUIRED";
    }
    return false;
  }

  await contentLocator.click({ timeout: 800 }).catch(() => contentLocator.click({ timeout: 800, force: true }));
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.waitForTimeout(120);

  const paragraphBlocks = buildParagraphImagePlan(cleaned, 0).paragraphs;
  const blocks = paragraphBlocks.length
    ? paragraphBlocks
    : cleaned.split(/\n{2,}/).map((item) => normalizeParagraphText(item)).filter(Boolean);
  if (!blocks.length) return false;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    await moveCaretToEditorEnd(page);
    await page.keyboard.insertText(block);
    if (i < blocks.length - 1) {
      await insertParagraphGap(page);
    }
  }

  return verifyEditorHasExpectedText(page, blocks.join("\n\n"));
}

async function countEditorImages(page: Page) {
  const selectors = [
    ".se-main-container img",
    ".se-module-image img",
    ".se-image-resource",
  ];
  let maxCount = 0;

  for (const selector of selectors) {
    try {
      const count = await page.locator(selector).count();
      maxCount = Math.max(maxCount, count);
    } catch {
      // ignore
    }
  }

  const mainFrame = page.frame({ name: "mainFrame" });
  if (mainFrame) {
    for (const selector of selectors) {
      try {
        const count = await mainFrame.locator(selector).count();
        maxCount = Math.max(maxCount, count);
      } catch {
        // ignore
      }
    }
  }

  return maxCount;
}

async function setInputFilesByRoot(root: Page | Frame, imagePath: string) {
  const candidates = [
    "input[type='file'][accept*='image']",
    "input[type='file'][accept*='jpg']",
    "input[type='file']",
  ];

  for (const selector of candidates) {
    const fileInputs = root.locator(selector);
    const count = await fileInputs.count().catch(() => 0);
    if (count === 0) continue;

    for (let i = count - 1; i >= 0; i -= 1) {
      try {
        await fileInputs.nth(i).setInputFiles(imagePath);
        return true;
      } catch {
        // continue
      }
    }
  }

  return false;
}

async function clickTopToolbarByText(page: Page, text: string) {
  try {
    return await page.evaluate((label) => {
      const candidates = Array.from(document.querySelectorAll("button, a, li, span, div"));
      const target = candidates.find((el) => {
        const value = (el.textContent || "").trim();
        if (value !== label) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top > -5 && rect.top < 220;
      }) as HTMLElement | undefined;

      if (!target) return false;
      let clickable: HTMLElement | null = target;
      for (let i = 0; i < 4 && clickable; i += 1) {
        const tag = clickable.tagName.toLowerCase();
        if (tag === "button" || tag === "a" || clickable.getAttribute("role") === "button" || clickable.onclick) {
          break;
        }
        clickable = clickable.parentElement;
      }
      (clickable || target).click();
      return true;
    }, text);
  } catch {
    return false;
  }
}

async function clickImageSourceOption(page: Page) {
  for (const selector of IMAGE_SOURCE_OPTION_SELECTORS) {
    if (await clickIfVisible(page, selector, 1200).catch(() => false)) {
      await page.waitForTimeout(220);
      return true;
    }
  }

  for (const frame of page.frames()) {
    for (const selector of IMAGE_SOURCE_OPTION_SELECTORS) {
      if (await clickIfVisible(frame, selector, 1200).catch(() => false)) {
        await page.waitForTimeout(220);
        return true;
      }
    }
  }

  return false;
}

async function openImagePicker(page: Page) {
  await dismissBlockingEditorPopup(page);

  if (await clickTopToolbarByText(page, "사진")) {
    await page.waitForTimeout(250);
    await clickImageSourceOption(page).catch(() => {});
    return true;
  }

  if (await clickTopToolbarByText(page, "파일")) {
    await page.waitForTimeout(250);
    await clickImageSourceOption(page).catch(() => {});
    return true;
  }

  for (const selector of IMAGE_TOOL_SELECTORS) {
    if (await clickIfVisible(page, selector, 1400).catch(() => false)) {
      await page.waitForTimeout(300);
      await clickImageSourceOption(page).catch(() => {});
      return true;
    }
  }

  const mainFrame = page.frame({ name: "mainFrame" });
  if (mainFrame) {
    for (const selector of IMAGE_TOOL_SELECTORS) {
      try {
        if (await clickIfVisible(mainFrame, selector, 1400)) {
          await page.waitForTimeout(300);
          await clickImageSourceOption(page).catch(() => {});
          return true;
        }
      } catch {
        // ignore
      }
    }
  }

  try {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], a")) as HTMLElement[];
      const target = candidates.find((el) => {
        const text = (el.innerText || el.getAttribute("aria-label") || "").toLowerCase();
        return text.includes("사진") || text.includes("이미지");
      });
      if (!target) return false;
      target.click();
      return true;
    });
    if (clicked) {
      await page.waitForTimeout(300);
      await clickImageSourceOption(page).catch(() => {});
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

async function uploadSingleImage(page: Page, imagePath: string) {
  if (await setInputFilesByRoot(page, imagePath)) {
    return true;
  }

  for (const frame of page.frames()) {
    if (await setInputFilesByRoot(frame, imagePath)) {
      return true;
    }
  }

  const chooserPromise = page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
  await openImagePicker(page).catch(() => {});

  const chooser = await chooserPromise;
  if (chooser) {
    try {
      await chooser.setFiles(imagePath);
      return true;
    } catch {
      // fallback to direct input retry
    }
  }

  if (await setInputFilesByRoot(page, imagePath)) {
    return true;
  }

  for (const frame of page.frames()) {
    if (await setInputFilesByRoot(frame, imagePath)) {
      return true;
    }
  }

  return false;
}

async function hasFileTransferErrorPopup(page: Page) {
  const markers = ["파일 전송 오류", "알 수 없는 파일", "오류 파일은 문서에서 삭제됩니다"];
  for (const marker of markers) {
    if (await maybeVisible(page.locator(`text=${marker}`).first(), 250)) return true;
  }
  return false;
}

async function dismissFileTransferErrorPopup(page: Page) {
  if (!(await hasFileTransferErrorPopup(page))) return false;

  const confirmButtons = [
    "[data-group='popupLayer'] button:has-text('확인')",
    ".se-popup button:has-text('확인')",
    "button:has-text('확인')",
  ];

  for (const selector of confirmButtons) {
    if (await clickIfVisible(page, selector, 1200).catch(() => false)) {
      await page.waitForTimeout(250);
      return true;
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
  return true;
}

async function uploadImageAtCursorAndVerify(page: Page, imagePath: string, previousCount: number) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissBlockingEditorPopup(page);
    const uploaded = await uploadSingleImage(page, imagePath);
    if (!uploaded) {
      await page.waitForTimeout(350);
      continue;
    }

    await page.waitForTimeout(1700 + attempt * 500);
    if (await hasFileTransferErrorPopup(page)) {
      await dismissFileTransferErrorPopup(page);
      continue;
    }

    const currentCount = await countEditorImages(page);
    if (currentCount > previousCount) {
      return currentCount;
    }
  }

  return -1;
}

async function fillContentAndInsertImagesByParagraphPlan(page: Page, content: string, imagePaths: string[]) {
  const plan = buildParagraphImagePlan(content, imagePaths.length);
  if (!plan.paragraphs.length) return false;
  if (!plan.canPlaceImagesBetweenParagraphs) return false;
  console.log(
    `[publish] paragraph-image plan: paragraphs=${plan.paragraphs.length}, boundaries=${plan.imageGroupsByBoundary.length}, images=${imagePaths.length}`,
  );

  await dismissBlockingEditorPopup(page);
  const contentLocator = await focusContentEditorLocator(page);
  if (!contentLocator) return false;

  await contentLocator.click({ timeout: 800 }).catch(() => contentLocator.click({ timeout: 800, force: true }));
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.waitForTimeout(120);

  let previousCount = await countEditorImages(page);
  let insertedImages = 0;

  for (const imageIndex of plan.imageIndexesBeforeFirstParagraph) {
    const imagePath = imagePaths[imageIndex];
    if (!imagePath) return false;

    await moveCaretToEditorEnd(page);
    const currentCount = await uploadImageAtCursorAndVerify(page, imagePath, previousCount);
    if (currentCount < 0) return false;
    previousCount = currentCount;
    insertedImages += 1;
    await moveCaretToEditorEnd(page);
  }

  if (plan.imageIndexesBeforeFirstParagraph.length > 0 && plan.paragraphs.length > 0) {
    await insertParagraphGap(page);
  }

  for (let paragraphIndex = 0; paragraphIndex < plan.paragraphs.length; paragraphIndex += 1) {
    await moveCaretToEditorEnd(page);
    await page.keyboard.insertText(plan.paragraphs[paragraphIndex]);

    if (paragraphIndex >= plan.paragraphs.length - 1) continue;

    const imageGroup = plan.imageGroupsByBoundary[paragraphIndex] || [];
    if (imageGroup.length > 0) {
      await insertParagraphGap(page);
      for (const imageIndex of imageGroup) {
        const imagePath = imagePaths[imageIndex];
        if (!imagePath) return false;

        await moveCaretToEditorEnd(page);
        const currentCount = await uploadImageAtCursorAndVerify(page, imagePath, previousCount);
        if (currentCount < 0) return false;
        previousCount = currentCount;
        insertedImages += 1;
        await moveCaretToEditorEnd(page);
      }
      await insertParagraphGap(page);
    } else {
      await insertParagraphGap(page);
    }
  }

  if (insertedImages !== imagePaths.length) return false;
  return verifyEditorHasExpectedText(page, plan.expectedText);
}

async function insertImages(page: Page, imagePaths: string[]) {
  if (!imagePaths.length) return true;

  if (!(await focusContentEditor(page))) return false;
  await moveCaretToEditorEnd(page);

  let previousCount = await countEditorImages(page);
  for (const imagePath of imagePaths) {
    await moveCaretToEditorEnd(page);
    const currentCount = await uploadImageAtCursorAndVerify(page, imagePath, previousCount);
    if (currentCount < 0) return false;
    previousCount = currentCount;
  }

  return true;
}

async function editorContainsRawHtmlMarkup(page: Page) {
  const leakMarkers = [
    "<div class=\"se-component",
    "<p>",
    "<h1>",
    "<h2>",
    "</div>",
  ];

  try {
    const text = await page.evaluate(() => {
      const el = document.querySelector(".se-main-container") || document.body;
      return el?.textContent || "";
    });
    return leakMarkers.some((marker) => text.includes(marker));
  } catch {
    return false;
  }
}

function isPostWriteUrl(url: string) {
  const lower = url.toLowerCase();
  return lower.includes("postwriteform.naver") || lower.includes("postwrite");
}

function looksLikePublishedUrl(url: string) {
  const lower = url.toLowerCase();
  if (lower.includes("isafterwrite=true")) return true;
  if (lower.includes("postview.naver")) return true;
  if (/blog\.naver\.com\/[^/?#]+\/\d+/.test(lower)) return true;

  try {
    const parsed = new URL(url);
    const logNo = parsed.searchParams.get("logNo") || parsed.searchParams.get("postNo");
    if (logNo && /^\d+$/.test(logNo)) return true;
  } catch {
    // ignore
  }

  return false;
}

async function containsAnyMarkerText(page: Page, markers: string[]) {
  for (const marker of markers) {
    try {
      if (await maybeVisible(page.getByText(marker, { exact: false }).first(), 220)) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    return markers.some((marker) => bodyText.includes(marker));
  } catch {
    return false;
  }
}

async function containsAnyMarkerTextAcrossFrames(page: Page, markers: string[]) {
  if (await containsAnyMarkerText(page, markers)) return true;

  for (const frame of page.frames()) {
    for (const marker of markers) {
      try {
        if (await maybeVisible(frame.locator(`text=${marker}`).first(), 220)) {
          return true;
        }
      } catch {
        // ignore
      }
    }

    try {
      const frameText = await frame.evaluate(() => document.body?.innerText || "");
      if (markers.some((marker) => frameText.includes(marker))) return true;
    } catch {
      // ignore
    }
  }

  return false;
}

async function detectPublishValidationIssue(page: Page): Promise<PublishValidationIssue> {
  if (await containsAnyMarkerText(page, TITLE_REQUIRED_MARKERS)) return "TITLE_REQUIRED";
  if (await containsAnyMarkerText(page, CONTENT_REQUIRED_MARKERS)) return "CONTENT_REQUIRED";
  return "NONE";
}

async function getCurrentTitleText(page: Page) {
  let longest = "";

  for (const selector of TITLE_VERIFY_SELECTORS) {
    const locator = page.locator(selector).first();
    const text = await getLocatorText(locator);
    if (text.length > longest.length) longest = text;
  }

  return longest.trim();
}

async function ensureDraftReadyForPublish(page: Page, request: PublishRequest) {
  const targetTitle = request.title.trim();
  const targetContent = request.content.trim();
  if (!targetTitle || !targetContent) {
    return { ok: false, message: "제목/본문이 비어 있어 발행을 중단했습니다." };
  }

  const currentTitle = await getCurrentTitleText(page);
  const titleNeedle = targetTitle.replace(/\s+/g, "").slice(0, 4);
  const normalizedCurrentTitle = currentTitle.replace(/\s+/g, "");
  const titleLooksMissing =
    !normalizedCurrentTitle ||
    normalizedCurrentTitle.length < Math.min(3, targetTitle.length) ||
    (titleNeedle.length >= 2 && !normalizedCurrentTitle.includes(titleNeedle));

  if (titleLooksMissing) {
    const titleRecovered = await fillTitle(page, targetTitle);
    if (!titleRecovered) {
      return { ok: false, message: "발행 직전 제목 복구에 실패했습니다." };
    }
    await page.waitForTimeout(200);
  }

  const bodyLen = await getEditorTextLength(page);
  if (bodyLen < 3) {
    const bodyRecovered = await fillContent(page, targetContent);
    if (!bodyRecovered) {
      return { ok: false, message: "발행 직전 본문 복구에 실패했습니다." };
    }
  }

  return { ok: true, message: "" };
}

async function isPublishLayerOpen(page: Page) {
  for (const selector of PUBLISH_LAYER_ROOT_SELECTORS) {
    if (await maybeVisible(page.locator(selector).first(), 260)) return true;
  }

  for (const selector of PUBLISH_CONFIRM_SELECTORS) {
    if (await maybeVisible(page.locator(selector).first(), 260)) return true;
  }

  for (const text of CONFIRM_BUTTON_TEXTS) {
    const button = page.getByRole("button", { name: text }).first();
    if (await maybeVisible(button, 260)) return true;
  }

  return false;
}

async function openPublishLayer(page: Page) {
  await closePopups(page);
  if (await isPublishLayerOpen(page)) return true;

  for (const selector of PUBLISH_OPEN_SELECTORS) {
    try {
      if (await clickIfVisible(page, selector, 1200)) {
        await page.waitForTimeout(240);
        if (await isPublishLayerOpen(page)) return true;
      }
    } catch {
      // ignore
    }
  }

  for (const frame of page.frames()) {
    for (const selector of PUBLISH_OPEN_SELECTORS) {
      try {
        if (await clickIfVisible(frame, selector, 1200)) {
          await page.waitForTimeout(240);
          if (await isPublishLayerOpen(page)) return true;
        }
      } catch {
        // ignore
      }
    }
  }

  for (const text of ["발행", "Publish"]) {
    const roleButton = page.getByRole("button", { name: text }).first();
    if (await maybeVisible(roleButton, 500)) {
      await roleButton.click({ timeout: 1200 });
      await page.waitForTimeout(220);
      if (await isPublishLayerOpen(page)) return true;
    }
  }

  try {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];
      const target = candidates.find((el) => (el.innerText || "").includes("발행"));
      if (!target) return false;
      target.click();
      return true;
    });
    if (clicked) {
      await page.waitForTimeout(220);
      if (await isPublishLayerOpen(page)) return true;
    }
  } catch {
    // ignore
  }

  return isPublishLayerOpen(page);
}

async function tryPickBoard(page: Page) {
  const boardLabel = page.locator("text=게시판").first();
  if (!(await maybeVisible(boardLabel, 300))) return;

  const optionSelector = ".selectbox_option, .select_menu_item, [role='option']";
  const firstOption = page.locator(optionSelector).first();
  if (await maybeVisible(firstOption, 400)) {
    await firstOption.click({ timeout: 900 }).catch(() => {});
  }
}

async function hasPublishedContentDom(page: Page) {
  const selectors = [".se-main-container", ".se-component", "#post-view", ".post_ct"];
  for (const selector of selectors) {
    if (await maybeVisible(page.locator(selector), 400)) return true;
  }

  const mainFrame = page.frame({ name: "mainFrame" });
  if (mainFrame) {
    for (const selector of selectors) {
      try {
        if (await mainFrame.locator(selector).first().isVisible({ timeout: 400 })) return true;
      } catch {
        // ignore
      }
    }
  }

  return false;
}

async function publishedContentLength(page: Page) {
  let domLength = 0;
  try {
    domLength = await page.evaluate(() => {
      const node = document.querySelector(".se-main-container") || document.querySelector(".post_ct");
      return (node?.textContent || "").trim().length;
    });
  } catch {
    // ignore
  }

  const mainFrame = page.frame({ name: "mainFrame" });
  if (mainFrame) {
    try {
      const frameLen = await mainFrame.evaluate(() => {
        const node = document.querySelector(".se-main-container") || document.querySelector(".post_ct");
        return (node?.textContent || "").trim().length;
      });
      domLength = Math.max(domLength, frameLen);
    } catch {
      // ignore
    }
  }

  let queryLength = 0;
  try {
    const url = new URL(page.url());
    queryLength = Number(url.searchParams.get("contentLength") || "0");
  } catch {
    // ignore
  }

  return Math.max(domLength, queryLength);
}

async function waitForPublishSuccess(
  page: Page,
  timeoutMs = 45_000,
  options: { allowReload?: boolean } = {},
) {
  const allowReload = options.allowReload ?? true;
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    const url = page.url();
    const escapedPostwrite = !isPostWriteUrl(url);
    const publishedUrl = looksLikePublishedUrl(url);
    const hasContent = await hasPublishedContentDom(page);
    if ((publishedUrl || escapedPostwrite) && hasContent) {
      return { ok: true, postUrl: url };
    }
    await page.waitForTimeout(900);
  }

  if (!allowReload) {
    return { ok: false, postUrl: page.url() };
  }

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  const url = page.url();
  const escapedPostwrite = !isPostWriteUrl(url);
  const publishedUrl = looksLikePublishedUrl(url);
  const hasContent = await hasPublishedContentDom(page);
  if ((publishedUrl || escapedPostwrite) && hasContent) {
    return { ok: true, postUrl: url };
  }

  return { ok: false, postUrl: url };
}

async function isEditorLoadingScreen(page: Page) {
  return containsAnyMarkerTextAcrossFrames(page, EDITOR_LOADING_MARKERS);
}

async function isEditorInteractive(page: Page) {
  if (await isEditorLoadingScreen(page)) return false;

  for (const selector of TITLE_SELECTORS) {
    if (await maybeVisible(page.locator(selector).first(), 350)) return true;
  }

  if (await maybeVisible(page.locator(".se-main-container").first(), 350)) return true;
  if (await maybeVisible(page.locator(".se-section-text").first(), 350)) return true;

  for (const selector of PUBLISH_OPEN_SELECTORS) {
    if (await maybeVisible(page.locator(selector).first(), 250)) return true;
  }

  for (const frame of page.frames()) {
    for (const selector of TITLE_SELECTORS) {
      if (await maybeVisible(frame.locator(selector).first(), 300)) return true;
    }
    if (await maybeVisible(frame.locator(".se-main-container").first(), 300)) return true;
    if (await maybeVisible(frame.locator(".se-section-text").first(), 300)) return true;
  }

  return false;
}

async function waitForLoadingRecovery(
  page: Page,
  timeoutMs = 22_000,
): Promise<{ state: "published" | "editor" | "login" | "timeout"; postUrl: string }> {
  const startedAt = Date.now();
  const timeoutAt = startedAt + timeoutMs;
  let reloaded = false;

  while (Date.now() < timeoutAt) {
    const quickSuccess = await waitForPublishSuccess(page, 1_100, { allowReload: false });
    if (quickSuccess.ok) {
      return { state: "published", postUrl: quickSuccess.postUrl };
    }

    if (await looksLikeLoginPage(page)) {
      return { state: "login", postUrl: "" };
    }

    const loading = await isEditorLoadingScreen(page);
    if (!loading) {
      if (await isEditorInteractive(page)) {
        return { state: "editor", postUrl: page.url() };
      }
    } else {
      await page
        .waitForFunction(
          (markers: string[]) => {
            const text = document.body?.innerText || "";
            return !markers.some((marker) => text.includes(marker));
          },
          EDITOR_LOADING_MARKERS,
          { timeout: 3200, polling: 300 },
        )
        .catch(() => {});

      if (!reloaded && Date.now() - startedAt > Math.min(25_000, Math.floor(timeoutMs * 0.65))) {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        reloaded = true;
      }
    }

    await page.waitForTimeout(650);
  }

  return { state: "timeout", postUrl: page.url() };
}

async function clickPublishConfirmStep(page: Page) {
  for (const selector of PUBLISH_CONFIRM_SELECTORS) {
    if (await clickIfVisible(page, selector, 1200).catch(() => false)) return true;
  }

  for (const text of CONFIRM_BUTTON_TEXTS) {
    const button = page.getByRole("button", { name: text }).first();
    if (await maybeVisible(button, 300)) {
      await button.click({ timeout: 1200 }).catch(() => {});
      return true;
    }
  }

  try {
    const clicked = await page.evaluate((texts) => {
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button']")) as HTMLElement[];
      const target = candidates.find((el) => {
        const label = (el.innerText || el.textContent || "").trim();
        return texts.some((text) => label.includes(text));
      });
      if (!target) return false;
      target.click();
      return true;
    }, CONFIRM_BUTTON_TEXTS);
    return clicked;
  } catch {
    return false;
  }
}

async function confirmPublish(page: Page, request: PublishRequest): Promise<ConfirmPublishResult> {
  for (let round = 0; round < 10; round += 1) {
    const loadingRecovery = await waitForLoadingRecovery(page, round === 0 ? 18_000 : 10_000);
    if (loadingRecovery.state === "published") {
      return { ok: true, reason: "OK" as ReasonCode, postUrl: loadingRecovery.postUrl };
    }
    if (loadingRecovery.state === "login") {
      return { ok: false, reason: "NAVER_LOGIN_REQUIRED" as ReasonCode, postUrl: "" };
    }

    const quickCheck = await waitForPublishSuccess(page, 1_200, { allowReload: false });
    if (quickCheck.ok) return { ok: true, reason: "OK" as ReasonCode, postUrl: quickCheck.postUrl };

    if (await looksLikeLoginPage(page)) {
      return { ok: false, reason: "NAVER_LOGIN_REQUIRED" as ReasonCode, postUrl: "" };
    }

    const issueBeforeClick = await detectPublishValidationIssue(page);
    if (issueBeforeClick === "TITLE_REQUIRED") {
      if (!(await fillTitle(page, request.title.trim()))) {
        return { ok: false, reason: "POST_FAIL" as ReasonCode, postUrl: "" };
      }
      await page.waitForTimeout(220);
      await openPublishLayer(page).catch(() => {});
      continue;
    }
    if (issueBeforeClick === "CONTENT_REQUIRED") {
      if (!(await fillContent(page, request.content))) {
        return { ok: false, reason: "POST_FAIL" as ReasonCode, postUrl: "" };
      }
      await page.waitForTimeout(220);
      await openPublishLayer(page).catch(() => {});
      continue;
    }

    if (!(await isPublishLayerOpen(page))) {
      if (!(await openPublishLayer(page))) {
        await page.keyboard.press("Enter").catch(() => {});
      }
    }

    await tryPickBoard(page);

    let clickedAny = false;
    for (let step = 0; step < 3; step += 1) {
      const clicked = await clickPublishConfirmStep(page);
      if (!clicked) break;
      clickedAny = true;

      await page.waitForURL((url) => !isComposeWriteUrl(url.toString()), { timeout: 3200 }).catch(() => {});
      await page.waitForTimeout(350);

      const afterClickRecovery = await waitForLoadingRecovery(page, 24_000);
      if (afterClickRecovery.state === "published") {
        return { ok: true, reason: "OK" as ReasonCode, postUrl: afterClickRecovery.postUrl };
      }
      if (afterClickRecovery.state === "login") {
        return { ok: false, reason: "NAVER_LOGIN_REQUIRED" as ReasonCode, postUrl: "" };
      }

      const stepCheck = await waitForPublishSuccess(page, 1_400, { allowReload: false });
      if (stepCheck.ok) {
        return { ok: true, reason: "OK" as ReasonCode, postUrl: stepCheck.postUrl };
      }

      const issueAfterClick = await detectPublishValidationIssue(page);
      if (issueAfterClick === "TITLE_REQUIRED") {
        if (!(await fillTitle(page, request.title.trim()))) {
          return { ok: false, reason: "POST_FAIL" as ReasonCode, postUrl: "" };
        }
        await page.waitForTimeout(200);
        await openPublishLayer(page).catch(() => {});
        break;
      }
      if (issueAfterClick === "CONTENT_REQUIRED") {
        if (!(await fillContent(page, request.content))) {
          return { ok: false, reason: "POST_FAIL" as ReasonCode, postUrl: "" };
        }
        await page.waitForTimeout(200);
        await openPublishLayer(page).catch(() => {});
        break;
      }
    }

    if (!clickedAny) {
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(700);
    }
  }

  const finalRecovery = await waitForLoadingRecovery(page, 65_000);
  if (finalRecovery.state === "published") {
    return { ok: true, reason: "OK" as ReasonCode, postUrl: finalRecovery.postUrl };
  }
  if (finalRecovery.state === "login") {
    return { ok: false, reason: "NAVER_LOGIN_REQUIRED" as ReasonCode, postUrl: "" };
  }
  if (finalRecovery.state === "timeout") {
    return {
      ok: false,
      reason: "POST_FAIL" as ReasonCode,
      postUrl: finalRecovery.postUrl,
      message: "네이버 발행 확인 중 로딩이 오래 지속되어 실패했습니다.",
    };
  }

  return { ok: false, reason: "POST_FAIL" as ReasonCode, postUrl: "" };
}

async function publishToNaverOnce(request: PublishRequest, attempt: number): Promise<PublishPipelineResult> {
  ensureRuntimeDirs();
  let finalResult: PublishPipelineResult | null = null;
  const finish = (result: PublishPipelineResult) => {
    finalResult = result;
    return result;
  };

  if (!request.title?.trim() || !request.content?.trim()) {
    return finish({
      ok: false,
      reason: "POST_FAIL",
      postUrl: "",
      contentLength: 0,
      message: "제목 또는 본문이 비어 있습니다.",
    });
  }

  const credentials = loadCredentials();
  const headless = process.env.BROWSER_HEADLESS === "true";
  const traceEnabled = process.env.NAVER_TRACE_ENABLED !== "false";
  let traceStarted = false;
  let succeeded = false;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let tempImageFiles: string[] = [];

  try {
    browser = await getOrLaunchBrowser(headless);
    context = await createContext(browser);
    if (traceEnabled) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {});
      traceStarted = true;
    }
    page = await context.newPage();
    await installOverlayHandlers(page);

    const probe = await ensureComposeReady(page, credentials);
    if (!probe.ok) {
      return finish({
        ok: false,
        reason: probe.reason,
        postUrl: "",
        contentLength: 0,
        screenshotPath: probe.screenshotPath,
        message: "로그인 또는 세션 준비에 실패했습니다.",
      });
    }

    await context.storageState({ path: SESSION_FILE });

    const titleOk = await fillTitle(page, request.title.trim());
    if (!titleOk) {
      const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
      return finish({
        ok: false,
        reason: "POST_FAIL",
        postUrl: "",
        contentLength: 0,
        screenshotPath,
        message: "제목 입력 칸을 찾지 못했습니다.",
      });
    }

    tempImageFiles = prepareImageFiles(request.images || []);
    const canUseSectionStructure = tempImageFiles.length > 0;

    const contentOk = canUseSectionStructure
      ? await fillContentAndInsertImagesBySectionStructure(page, request, tempImageFiles)
      : tempImageFiles.length > 0
        ? await fillContentAndInsertImagesByParagraphPlan(page, request.content, tempImageFiles)
        : await fillContent(page, request.content);

    if (!contentOk) {
      if (tempImageFiles.length > 0) {
        const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
        return finish({
          ok: false,
          reason: "POST_FAIL",
          postUrl: "",
          contentLength: 0,
          screenshotPath,
          message: canUseSectionStructure
            ? "섹션 구조(이미지/소제목/본문) 작성 중 실패했습니다."
            : "이미지를 단락과 단락 사이에 배치하는 중 실패했습니다.",
        });
      }

      const fallbackBodyLen = await getEditorTextLength(page);
      const fallbackHasSignals = await hasEditorContentSignals(page);
      const validationIssue = await detectPublishValidationIssue(page);
      const canProceed =
        (fallbackBodyLen >= 3 || fallbackHasSignals) &&
        validationIssue !== "CONTENT_REQUIRED";

      if (!canProceed) {
        const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
        return finish({
          ok: false,
          reason: "POST_FAIL",
          postUrl: "",
          contentLength: 0,
          screenshotPath,
          message: "본문 입력에 실패했습니다.",
        });
      }
    }

    if (tempImageFiles.length > 0) {
      const imageCount = await countEditorImages(page);
      if (imageCount < tempImageFiles.length) {
        const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
        return finish({
          ok: false,
          reason: "POST_FAIL",
          postUrl: "",
          contentLength: 0,
          screenshotPath,
          message: "이미지가 섹션 수에 맞게 충분히 삽입되지 않았습니다.",
        });
      }
    }

    if (await editorContainsRawHtmlMarkup(page)) {
      const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
      return finish({
        ok: false,
        reason: "POST_FAIL",
        postUrl: "",
        contentLength: 0,
        screenshotPath,
        message: "본문에 HTML 태그 문자열이 섞여 발행을 중단했습니다.",
      });
    }

    const draftReady = await ensureDraftReadyForPublish(page, request);
    if (!draftReady.ok) {
      const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
      return finish({
        ok: false,
        reason: "POST_FAIL",
        postUrl: "",
        contentLength: 0,
        screenshotPath,
        message: draftReady.message,
      });
    }

    if (tempImageFiles.length > 0) {
      const imageCountAfterRecovery = await countEditorImages(page);
      if (imageCountAfterRecovery < tempImageFiles.length) {
        const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
        return finish({
          ok: false,
          reason: "POST_FAIL",
          postUrl: "",
          contentLength: 0,
          screenshotPath,
          message: "발행 직전 이미지 섹션 배치가 유지되지 않아 중단했습니다.",
        });
      }
    }

    const publishLayerOpened = await openPublishLayer(page);
    if (!publishLayerOpened) {
      const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
      return finish({
        ok: false,
        reason: "POST_FAIL",
        postUrl: "",
        contentLength: 0,
        screenshotPath,
        message: "발행 버튼을 열지 못했습니다.",
      });
    }

    const confirm = await confirmPublish(page, request);
    if (!confirm.ok) {
      const screenshotPath = await saveFailureScreenshot(page, confirm.reason);
      return finish({
        ok: false,
        reason: confirm.reason,
        postUrl: confirm.postUrl || "",
        contentLength: 0,
        screenshotPath,
        message: confirm.message || "발행 확인 단계에서 실패했습니다.",
      });
    }

    const verified = await waitForPublishSuccess(page);
    if (!verified.ok) {
      const screenshotPath = await saveFailureScreenshot(page, "POST_FAIL");
      return finish({
        ok: false,
        reason: "POST_FAIL",
        postUrl: confirm.postUrl,
        contentLength: 0,
        screenshotPath,
        message: "발행 후 검증에 실패했습니다.",
      });
    }

    const contentLength = await publishedContentLength(page);
    await context.storageState({ path: SESSION_FILE });

    succeeded = true;
    return finish({
      ok: true,
      reason: "OK",
      postUrl: verified.postUrl,
      contentLength,
      message: "네이버 블로그 발행이 완료되었습니다.",
    });
  } catch (error: any) {
    const fallbackShot = page ? await saveFailureScreenshot(page, "UNKNOWN") : "";
    console.error("publishToNaver error:", error);
    return finish({
      ok: false,
      reason: "UNKNOWN",
      postUrl: "",
      contentLength: 0,
      screenshotPath: fallbackShot || undefined,
      message: toUserFacingMessage(error),
    });
  } finally {
    cleanupTempFiles(tempImageFiles);
    if (context && traceStarted) {
      if (succeeded) {
        await context.tracing.stop().catch(() => {});
      } else {
        const reasonForTrace = finalResult?.reason || "UNKNOWN";
        const tracePath = getFailureTracePath(reasonForTrace, attempt);
        await context.tracing.stop({ path: tracePath }).catch(() => {});
        if (finalResult && !finalResult.tracePath) {
          finalResult.tracePath = tracePath;
        }
      }
    }
    await context?.close().catch(() => {});
    // Don't close global browser - it's reused for performance optimization
    // Only close context for isolation
  }
}

export async function publishToNaver(request: PublishRequest): Promise<PublishPipelineResult> {
  ensureRuntimeDirs();

  if (!request.title?.trim() || !request.content?.trim()) {
    return {
      ok: false,
      reason: "POST_FAIL",
      postUrl: "",
      contentLength: 0,
      message: "제목 또는 본문이 비어 있습니다.",
    };
  }

  if (isPublishInFlight) {
    return {
      ok: false,
      reason: "POST_FAIL",
      postUrl: "",
      contentLength: 0,
      message: "이전 발행 작업이 아직 진행 중입니다. 10초 후 다시 눌러주세요.",
    };
  }

  isPublishInFlight = true;
  try {
    const maxAttempts = getMaxPublishAttempts();
    let lastResult: PublishPipelineResult | null = null;
    let usedAttempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      usedAttempts = attempt;
      const result = await publishToNaverOnce(request, attempt);
      if (result.ok) return result;

      lastResult = result;
      if (!isRetryableReason(result.reason)) break;
      if (attempt >= maxAttempts) break;

      const retryDelay = Math.min(7_000, 1_500 * attempt);
      await sleep(retryDelay);
    }

    if (!lastResult) {
      return {
        ok: false,
        reason: "UNKNOWN",
        postUrl: "",
        contentLength: 0,
        message: "발행 결과를 확인하지 못했습니다.",
      };
    }

    if (usedAttempts > 1) {
      return {
        ...lastResult,
        message: `${lastResult.message} (자동 재시도 ${usedAttempts}회 후 실패)`,
      };
    }

    return lastResult;
  } finally {
    isPublishInFlight = false;
  }
}
