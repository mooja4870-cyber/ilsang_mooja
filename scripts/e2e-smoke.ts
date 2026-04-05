import axios from "axios";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

const BASE_URL = (process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
const STARTUP_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 8_000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isApiReady() {
  try {
    const response = await axios.get(`${BASE_URL}/api/config`, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Cache-Control": "no-cache" },
      validateStatus: () => true,
    });
    return response.status === 200 && isRecord(response.data) && "geminiApiKey" in response.data;
  } catch {
    return false;
  }
}

async function waitForApiReady() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (await isApiReady()) return true;
    await sleep(700);
  }
  return false;
}

function startDevServer() {
  const child = spawn("npm", ["run", "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[dev] ${String(chunk)}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[dev] ${String(chunk)}`);
  });

  return child;
}

async function stopDevServer(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function run() {
  let serverProcess: ChildProcessWithoutNullStreams | null = null;
  let startedByTest = false;

  try {
    if (!(await isApiReady())) {
      serverProcess = startDevServer();
      startedByTest = true;
    }

    const ready = await waitForApiReady();
    if (!ready) {
      throw new Error(`API 서버가 기동되지 않았습니다. (${BASE_URL})`);
    }

    const configResponse = await axios.get(`${BASE_URL}/api/config`, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Cache-Control": "no-cache" },
    });
    if (!isRecord(configResponse.data) || typeof configResponse.data.geminiApiKey !== "string") {
      throw new Error("`/api/config` 응답 형식이 올바르지 않습니다.");
    }

    const enqueueResponse = await axios.post(
      `${BASE_URL}/api/publish-async`,
      {
        title: `[SMOKE] ${new Date().toISOString()}`,
        content: "스모크 테스트용 발행 요청입니다. 실제 발행 없이 응답 형식만 검증합니다.",
        images: [],
        blogType: "Naver",
      },
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Cache-Control": "no-cache",
          "x-smoke-test": "1",
        },
      },
    );

    const enqueueData = enqueueResponse.data;
    if (!isRecord(enqueueData) || enqueueData.success !== true) {
      throw new Error("`/api/publish-async` 응답에서 success=true를 확인하지 못했습니다.");
    }

    const jobId = typeof enqueueData.jobId === "string" ? enqueueData.jobId.trim() : "";
    if (!jobId) {
      throw new Error("`/api/publish-async` 응답에서 jobId를 받지 못했습니다.");
    }

    const statusResponse = await axios.get(`${BASE_URL}/api/publish-status/${jobId}`, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Cache-Control": "no-cache" },
    });
    const statusData = statusResponse.data;
    if (!isRecord(statusData)) {
      throw new Error("`/api/publish-status/:jobId` 응답 형식이 올바르지 않습니다.");
    }
    if (statusData.jobId !== jobId) {
      throw new Error("`/api/publish-status/:jobId`의 jobId가 요청값과 일치하지 않습니다.");
    }
    if (statusData.success !== true || statusData.done !== true || statusData.status !== "success") {
      throw new Error("스모크 상태 검증에 실패했습니다. (success/done/status)");
    }

    console.log(`SMOKE TEST PASS: ${BASE_URL}`);
  } finally {
    if (startedByTest) {
      await stopDevServer(serverProcess);
    }
  }
}

run().catch((error) => {
  console.error(`SMOKE TEST FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
