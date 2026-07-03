import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 앱 데이터 디렉토리 (SQLite DB, 재시작 로그 등).
 *
 * 기존 Electron 앱과 동일한 userData 경로를 기본값으로 재사용해
 * 프록시 목록/설정을 그대로 이어받는다. SCRAPPER_DATA_DIR 로 override 가능.
 */
export const DATA_DIR =
  process.env.SCRAPPER_DATA_DIR ??
  join(homedir(), "Library", "Application Support", "selltkeyscrapper-grande");
