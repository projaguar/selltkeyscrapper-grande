/**
 * 네이버 크롤링 로직
 */

import type { CrawlTask, CrawlResult } from "../types";
import { postGoodsList } from "../task-manager";
import { logBlocked } from "../restart-logger";

/**
 * CAPTCHA 감지
 */
export async function detectNaverCaptcha(page: any): Promise<boolean> {
  try {
    const pageInfo = await page.evaluate(() => {
      const captchaScript = document.querySelector(
        'script[src*="wtm_captcha.js"]',
      );
      const captchaFrame = document.querySelector('iframe[src*="captcha"]');
      const captchaContainer = document.querySelector(".captcha_container");
      const loginForm = document.querySelector("#frmNIDLogin");

      return {
        hasCaptchaScript: !!captchaScript,
        hasCaptchaFrame: !!captchaFrame,
        hasCaptchaContainer: !!captchaContainer,
        hasLoginForm: !!loginForm,
      };
    });

    return (
      (pageInfo.hasCaptchaScript ||
        pageInfo.hasCaptchaFrame ||
        pageInfo.hasCaptchaContainer) &&
      pageInfo.hasLoginForm
    );
  } catch (error) {
    console.log(`[Naver] CAPTCHA check error:`, error);
    return false;
  }
}

/**
 * 네이버 크롤링
 */
export async function crawlNaver(
  page: any,
  task: CrawlTask,
  profileName: string,
): Promise<CrawlResult> {
  // CAPTCHA 체크
  if (await detectNaverCaptcha(page)) {
    console.log(`[Naver] ${profileName} - CAPTCHA detected!`);
    logBlocked("NAVER_CAPTCHA", profileName);
    return {
      success: false,
      urlNum: task.URLNUM,
      storeName: task.TARGETSTORENAME,
      captchaDetected: true,
      error: "CAPTCHA detected - profile needs recreation",
    };
  }

  // __PRELOADED_STATE__ 데이터 추출
  const data: any = await page.evaluate(() => {
    return (globalThis as any).window.__PRELOADED_STATE__;
  });

  const result: CrawlResult = {
    success: false,
    urlNum: task.URLNUM,
    storeName: task.TARGETSTORENAME,
    data: {
      error: true,
      errorMsg: "",
      list: [],
    },
  };

  // 서버에 데이터 전송
  let postData: any;
  if (!data) {
    result.data!.errorMsg = "데이터 로드 실패";
    // 에러 결과는 isParsed: true로 전송
    postData = {
      data: {
        urlnum: task.URLNUM,
        usernum: task.USERNUM,
        spricelimit: task.SPRICELIMIT,
        epricelimit: task.EPRICELIMIT,
        platforms: task.URLPLATFORMS,
        bestyn: task.BESTYN,
        newyn: task.NEWYN,
        result: result.data,
      },
      context: { isParsed: true },
    };
  } else {
    // raw data를 서버로 전송 (서버에서 파싱)
    result.success = true;
    postData = {
      data: data,
      context: {
        isParsed: false,
        urlnum: task.URLNUM,
        usernum: task.USERNUM,
        spricelimit: task.SPRICELIMIT,
        epricelimit: task.EPRICELIMIT,
        platforms: task.URLPLATFORMS,
        bestyn: task.BESTYN,
        newyn: task.NEWYN,
      },
    };
  }

  const postResult = await postGoodsList(postData, task.URLPLATFORMS);
  result.todayStop = postResult.todayStop;
  result.serverTransmitted = postResult.success;
  result.urlcount = postResult.urlcount;

  const statusIcon = result.success ? "✓" : "✗";
  const transmitStatus = postResult.success
    ? postResult.todayStop
      ? "중단"
      : "완료"
    : "실패";
  console.log(
    `[Naver] ${statusIcon} ${task.TARGETSTORENAME} | ${result.data!.errorMsg || `${postResult.urlcount}개 수집`} | Naver 서버전송: ${transmitStatus}`,
  );

  return result;
}
