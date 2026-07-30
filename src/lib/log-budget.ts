/**
 * 로그 예산 (REDESIGN §5 — 365일 무인 운영의 필수 조건).
 *
 * 교체 후 25.5시간 실측: out 651MB + err 95MB = 746MB (초당 98줄, 평균 75B/줄).
 * 그대로면 0.7GB/일 → 365일 250GB. 디스크 여유 161GB 기준 약 230일에 고갈되고,
 * 디스크가 차면 SQLite 쓰기와 크롤이 동시에 멈춘다 — 무인 운영의 단일 실패점이다.
 *
 * 두 축으로 막는다:
 *  1) 상세 로그 기본 off (`verboseLogging()`). 용량의 80%가 태스크당 추적 로그
 *     (`[Navigate]` 48% + `[TaskQueue]` 32%)였고, 정상 운영에서는 가치가 낮다.
 *     비즈니스 기록(`[Naver] ✓`)과 경고/에러는 항상 남긴다.
 *  2) 파일 상한 + 꼬리 보존 트림. launchd 가 stdout/stderr fd 를 소유하므로 앱이
 *     파일을 갈아치울 수는 없지만, O_APPEND 는 항상 EOF 에 쓰므로 잘라내면
 *     그 뒤부터 이어 쓴다. 최근 구간을 남기고 앞을 버린다.
 */

import { statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";

/** 상세 로그 스위치. 기본 off — 문제 조사 시 SCRAPPER_VERBOSE=1 로 켠다. */
const VERBOSE = process.env.SCRAPPER_VERBOSE === "1";

export function verboseLogging(): boolean {
  return VERBOSE;
}

/** 파일 하나가 이 크기를 넘으면 트림한다. */
const CAP_BYTES = Number(process.env.SCRAPPER_LOG_CAP_MB ?? 200) * 1024 ** 2;
/** 트림 후 남길 최근 구간. 사고 조사에 필요한 직전 맥락은 보존해야 한다. */
const KEEP_BYTES = Number(process.env.SCRAPPER_LOG_KEEP_MB ?? 20) * 1024 ** 2;
const CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * 파일 앞부분을 버리고 마지막 KEEP_BYTES 만 남긴다.
 * 트림 창(읽기→쓰기) 동안의 기록은 유실될 수 있으나, 로그에서는 허용 가능한 손실이다.
 */
function trimFile(path: string): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false; // 아직 생성되지 않았거나 접근 불가
  }
  if (size <= CAP_BYTES) return false;

  const keep = Math.min(KEEP_BYTES, size);
  const buffer = Buffer.allocUnsafe(keep);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, keep, size - keep);
  } finally {
    closeSync(fd);
  }

  // 첫 줄이 잘렸을 수 있으니 첫 개행 이후부터 남긴다(깨진 줄로 시작하지 않게).
  const firstNewline = buffer.indexOf(0x0a);
  const body = firstNewline >= 0 ? buffer.subarray(firstNewline + 1) : buffer;
  const header = Buffer.from(
    `--- 로그 트림: ${new Date().toISOString()} ` +
      `이전 ${Math.round(size / 1024 ** 2)}MB 중 앞부분을 버리고 최근 ` +
      `${Math.round(body.length / 1024 ** 2)}MB 만 남김 (상한 ${Math.round(CAP_BYTES / 1024 ** 2)}MB) ---\n`,
  );
  writeFileSync(path, Buffer.concat([header, body]));
  console.warn(
    `[LogBudget] ${path} 트림: ${Math.round(size / 1024 ** 2)}MB → ${Math.round((header.length + body.length) / 1024 ** 2)}MB`,
  );
  return true;
}

/**
 * 주기적 트림을 시작한다. 반환된 함수로 중지한다.
 * 기동 직후 한 번 검사해, 이미 비대해진 파일을 즉시 회수한다.
 */
export function startLogBudget(paths: readonly string[]): () => void {
  const sweep = (): void => {
    for (const path of paths) {
      try {
        trimFile(path);
      } catch (error: unknown) {
        console.warn(
          `[LogBudget] ${path} 트림 실패(무시): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  sweep();
  const timer = setInterval(sweep, CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
