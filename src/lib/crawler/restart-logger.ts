/**
 * 브라우저 재시작 원인 로거
 * - 재시작 원인을 카테고리별로 분류
 * - 로그 파일에 기록 (userData/restart-log.tsv)
 * - 콘솔에도 카테고리 태그 출력
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";

// ========================================
// 재시작 원인 카테고리
// ========================================

export type RestartCategory =
  | "TIMEOUT"       // 네트워크 타임아웃 (Navigation timeout, ETIMEDOUT 등)
  | "NETWORK"       // 네트워크 연결 실패 (ECONNREFUSED, ECONNRESET 등)
  | "BLOCKED"       // 차단 감지 (Cloudflare, IP change needed)
  | "CAPTCHA"       // CAPTCHA 감지
  | "BROWSER_DEAD"  // 브라우저 프로세스 죽음
  | "ERROR_RECOVERY" // 기타 에러 복구
  | "IP_CHANGE";    // IP 일괄 변경

// 카테고리 판별 패턴 (순서 중요: 구체적 → 일반적)
const CATEGORY_PATTERNS: { category: RestartCategory; patterns: RegExp[] }[] = [
  {
    category: "CAPTCHA",
    patterns: [/captcha/i, /캡차/i],
  },
  {
    category: "BLOCKED",
    patterns: [
      /Cloudflare/i,
      /IP change needed/i,
      /blocked/i,
      /차단/i,
      /403/,
      /Access Denied/i,
    ],
  },
  {
    category: "BROWSER_DEAD",
    patterns: [
      /Protocol error/i,
      /Session closed/i,
      /Target closed/i,
      /browser.*died/i,
      /프로세스 죽음/i,
      /에러 복구/,
      /Attempted to use/i,
      /detached Frame/i,
      /Execution context was destroyed/i,
      /health check 실패/,
    ],
  },
  {
    category: "TIMEOUT",
    patterns: [
      /timeout/i,
      /ETIMEDOUT/i,
      /Timeout waiting/i,
      /Navigation timeout/i,
      /net::ERR_TIMED_OUT/i,
      /net::ERR_CONNECTION_TIMED_OUT/i,
    ],
  },
  {
    category: "NETWORK",
    patterns: [
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /ENOTFOUND/i,
      /net::ERR_/i,
      /페이지 로드 실패/,
      /이동 실패/,
      /socket hang up/i,
      /네트워크 오류/,
    ],
  },
];

function classifyCategory(reason: string, errorMsg?: string): RestartCategory {
  const combined = `${reason} ${errorMsg || ""}`;

  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some((p) => p.test(combined))) {
      return category;
    }
  }

  return "ERROR_RECOVERY";
}

// ========================================
// 로그 파일 관리
// ========================================

let logFilePath: string | null = null;

export function initRestartLogger(userDataPath: string): void {
  const logDir = join(userDataPath, "logs");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // 날짜별 로그 파일
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  logFilePath = join(logDir, `restart-${today}.tsv`);

  // 헤더 (파일이 없을 때만)
  if (!existsSync(logFilePath)) {
    appendFileSync(
      logFilePath,
      "시간\t카테고리\t프로필\t워커\treason\t상세에러\n",
    );
  }

  console.log(`[RestartLogger] Log file: ${logFilePath}`);
}

// ========================================
// 블록 로그 (사이트별 차단 기록)
// ========================================

let blockLogFilePath: string | null = null;

function ensureBlockLogFile(): void {
  if (blockLogFilePath) return;
  if (!logFilePath) return;
  const logDir = dirname(logFilePath);
  const today = new Date().toISOString().slice(0, 10);
  blockLogFilePath = join(logDir, `blocked-${today}.tsv`);
  if (!existsSync(blockLogFilePath)) {
    appendFileSync(blockLogFilePath, "시간\t사이트\t프로필\n");
  }
}

export function logBlocked(site: string, profileName: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[Blocked] ${site} | ${profileName}`);

  ensureBlockLogFile();
  if (blockLogFilePath) {
    try {
      appendFileSync(blockLogFilePath, `${timestamp}\t${site}\t${profileName}\n`);
    } catch {
      // 파일 쓰기 실패 무시
    }
  }
}

// ========================================
// 서버 전송 실패 로그 (URL / 전송 데이터 / 응답 오류)
// ========================================

let transmitFailLogFilePath: string | null = null;
let transmitFailDumpDir: string | null = null;

function ensureTransmitFailLogFile(): void {
  if (transmitFailLogFilePath) return;
  if (!logFilePath) return;
  const logDir = dirname(logFilePath);
  const today = new Date().toISOString().slice(0, 10);

  transmitFailLogFilePath = join(logDir, `transmit-fail-${today}.tsv`);
  if (!existsSync(transmitFailLogFilePath)) {
    appendFileSync(
      transmitFailLogFilePath,
      "시간\t플랫폼\tURL\tHTTP상태\t에러\tpayload크기\tcontext\t상세파일\n",
    );
  }

  // 전체 payload/응답 본문을 보관할 디렉토리
  transmitFailDumpDir = join(logDir, "transmit-fail");
  if (!existsSync(transmitFailDumpDir)) {
    mkdirSync(transmitFailDumpDir, { recursive: true });
  }
}

export interface TransmitFailEntry {
  platform: string;
  url: string;
  error: string; // 에러 메시지 (HTTP status 또는 예외 메시지)
  status?: number; // HTTP 상태 코드 (있을 경우)
  responseBody?: string; // 서버가 반환한 응답 본문
  payload: any; // 실제 전송한 데이터
}

export function logTransmitFail(entry: TransmitFailEntry): void {
  const now = new Date();
  const timestamp = now.toISOString().slice(11, 19); // HH:MM:SS

  // payload 직렬화 및 크기 계산
  let payloadStr = "";
  let payloadSize = 0;
  try {
    payloadStr = JSON.stringify(entry.payload);
    payloadSize = Buffer.byteLength(payloadStr);
  } catch {
    payloadStr = "<직렬화 실패>";
  }

  // context 요약 (usernum/urlnum 등)
  const ctx = entry.payload?.context || {};
  const ctxSummary = `usernum=${ctx.usernum ?? "-"},urlnum=${ctx.urlnum ?? "-"}`;

  // 콘솔 출력
  console.error(
    `[TransmitFail] ${entry.platform} | ${entry.url} | ${entry.error} | ${ctxSummary} | ${payloadSize}B`,
  );

  ensureTransmitFailLogFile();

  // 전체 payload + 응답 본문을 별도 JSON 파일로 덤프
  let dumpFileName = "-";
  if (transmitFailDumpDir) {
    const safeTime = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
    dumpFileName = `${safeTime}_${entry.platform}_${ctx.urlnum ?? "x"}_${ctx.usernum ?? "x"}.json`;
    try {
      writeFileSync(
        join(transmitFailDumpDir, dumpFileName),
        JSON.stringify(
          {
            time: now.toISOString(),
            platform: entry.platform,
            url: entry.url,
            status: entry.status ?? null,
            error: entry.error,
            responseBody: entry.responseBody ?? null,
            payload: entry.payload,
          },
          null,
          2,
        ),
      );
    } catch (e: any) {
      console.error(`[TransmitFail] 덤프 파일 작성 실패: ${e?.message}`);
      dumpFileName = "<덤프실패>";
    }
  }

  // 요약 TSV 기록
  if (transmitFailLogFilePath) {
    const safeError = (entry.error || "-").replace(/[\t\n\r]/g, " ");
    const line = `${timestamp}\t${entry.platform}\t${entry.url}\t${entry.status ?? "-"}\t${safeError}\t${payloadSize}\t${ctxSummary}\t${dumpFileName}\n`;
    try {
      appendFileSync(transmitFailLogFilePath, line);
    } catch {
      // 파일 쓰기 실패 무시
    }
  }
}

// ========================================
// Skip 예외 상세 로그 (특히 '기타(exception)' 원인 추적)
// ========================================

let skipErrorLogFilePath: string | null = null;

function ensureSkipErrorLogFile(): void {
  if (skipErrorLogFilePath) return;
  if (!logFilePath) return;
  const logDir = dirname(logFilePath);
  const today = new Date().toISOString().slice(0, 10);
  skipErrorLogFilePath = join(logDir, `skip-error-${today}.tsv`);
  if (!existsSync(skipErrorLogFilePath)) {
    appendFileSync(
      skipErrorLogFilePath,
      "시간\t분류\t플랫폼\t워커\t프로필\tURLNUM\tUSERNUM\t에러\t스택\n",
    );
  }
}

export interface SkipErrorEntry {
  reason: string; // skip 분류 (exception / cloudflareBlock / deadBrowser 등)
  platform?: string;
  workerIndex: number;
  profileName: string;
  urlnum?: string | number;
  usernum?: string | number;
  errorMsg: string;
  stack?: string;
}

export function logSkipError(entry: SkipErrorEntry): void {
  const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS

  // 콘솔 출력
  console.error(
    `[SkipError][${entry.reason}] Worker ${entry.workerIndex} | ${entry.profileName} | ${entry.platform ?? "-"} | urlnum=${entry.urlnum ?? "-"} | ${entry.errorMsg}`,
  );

  ensureSkipErrorLogFile();

  if (skipErrorLogFilePath) {
    const clean = (s?: string) => (s || "-").replace(/[\t\r\n]/g, " ");
    // 스택은 한 줄로 평탄화하여 보관 (탭/개행 제거)
    const stackOneLine = entry.stack
      ? entry.stack.replace(/[\t\r\n]+/g, " ⏎ ")
      : "-";
    const line = `${timestamp}\t${entry.reason}\t${entry.platform ?? "-"}\t${entry.workerIndex}\t${entry.profileName}\t${entry.urlnum ?? "-"}\t${entry.usernum ?? "-"}\t${clean(entry.errorMsg)}\t${stackOneLine}\n`;
    try {
      appendFileSync(skipErrorLogFilePath, line);
    } catch {
      // 파일 쓰기 실패 무시
    }
  }
}

// ========================================
// 로그 기록
// ========================================

export interface RestartLogEntry {
  profileName: string;
  workerIndex: number;
  reason: string;
  errorMsg?: string;
  category?: RestartCategory; // 직접 지정 가능 (IP_CHANGE 등)
}

export function logRestart(entry: RestartLogEntry): RestartCategory {
  const category = entry.category || classifyCategory(entry.reason, entry.errorMsg);
  const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const errorDetail = entry.errorMsg || "-";

  // 콘솔 출력 (카테고리 태그 포함)
  console.log(
    `[Restart][${category}] Worker ${entry.workerIndex} | ${entry.profileName} | ${entry.reason}${entry.errorMsg ? ` | ${entry.errorMsg}` : ""}`,
  );

  // 파일 기록
  if (logFilePath) {
    const line = `${timestamp}\t${category}\t${entry.profileName}\t${entry.workerIndex}\t${entry.reason}\t${errorDetail}\n`;
    try {
      appendFileSync(logFilePath, line);
    } catch {
      // 파일 쓰기 실패 무시
    }
  }

  return category;
}

// ========================================
// 통계 (세션 내 메모리)
// ========================================

const stats: Record<RestartCategory, number> = {
  TIMEOUT: 0,
  NETWORK: 0,
  BLOCKED: 0,
  CAPTCHA: 0,
  BROWSER_DEAD: 0,
  ERROR_RECOVERY: 0,
  IP_CHANGE: 0,
};

export function incrementStat(category: RestartCategory): void {
  stats[category]++;
}

export function getRestartStats(): Record<RestartCategory, number> {
  return { ...stats };
}

export function resetRestartStats(): void {
  for (const key of Object.keys(stats) as RestartCategory[]) {
    stats[key] = 0;
  }
}
