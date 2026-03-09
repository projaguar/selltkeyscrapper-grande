/**
 * 옥션 크롤링 로직
 */

import type { CrawlTask, CrawlResult } from "../types";
import { postGoodsList } from "../task-manager";
import { logBlocked } from "../restart-logger";

/**
 * Cloudflare 블록 감지
 */
export async function detectCloudflareBlock(page: any): Promise<boolean> {
  try {
    const pageInfo = await page.evaluate(() => {
      const bodyText = document.body?.textContent || "";
      const hasCloudflareScript = !!(window as any)._cf_chl_opt;

      return {
        hasBlockText: bodyText.includes("사용자 활동 검토 요청") ||
                      bodyText.includes("봇의 동작과 유사") ||
                      bodyText.includes("Enable JavaScript and cookies to continue"),
        hasCloudflareScript: hasCloudflareScript,
        title: document.title || "",
      };
    });

    const isBlocked = pageInfo.hasBlockText || pageInfo.hasCloudflareScript;

    if (isBlocked) {
      console.log(`[Auction] Cloudflare block detected - Title: ${pageInfo.title}`);
    }

    return isBlocked;
  } catch (error: any) {
    console.log(`[Auction] Cloudflare block check error:`, error.message);
    return false;
  }
}

/**
 * CAPTCHA 감지
 */
export async function detectAuctionCaptcha(page: any): Promise<boolean> {
  try {
    const pageInfo = await page.evaluate(() => {
      const captchaScript = document.querySelector(
        'script[src*="wtm_captcha.js"]'
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
    console.log(`[Auction] CAPTCHA check error:`, error);
    return false;
  }
}

/**
 * 옥션 크롤링
 * - raw data를 서버로 전송 (서버에서 파싱)
 */
export async function crawlAuction(
  page: any,
  task: CrawlTask,
  profileName: string
): Promise<CrawlResult> {
  // Cloudflare 블록 체크 (브라우저 재시작 필요)
  if (await detectCloudflareBlock(page)) {
    console.log(`[Auction] ${profileName} - Cloudflare block detected!`);
    logBlocked("AUCTION", profileName);
    throw new Error("Cloudflare block detected - IP change needed");
  }

  // CAPTCHA 체크
  if (await detectAuctionCaptcha(page)) {
    console.log(`[Auction] ${profileName} - CAPTCHA detected!`);
    logBlocked("AUCTION_CAPTCHA", profileName);
    return {
      success: false,
      urlNum: task.URLNUM,
      storeName: task.TARGETSTORENAME,
      captchaDetected: true,
      error: "CAPTCHA detected - profile needs recreation",
    };
  }

  // __NEXT_DATA__ 데이터 추출
  const textContent = await page.evaluate(() => {
    const element = document.getElementById("__NEXT_DATA__");
    return element?.textContent ?? null;
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

  if (!textContent) {
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
    let data: any;
    try {
      data = JSON.parse(textContent);
    } catch {
      result.data!.errorMsg = "데이터 파싱 실패";
      // 파싱 에러 결과는 isParsed: true로 전송
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
    }

    if (data) {
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
    `[Auction] ${statusIcon} ${task.TARGETSTORENAME} | ${result.data!.errorMsg || `${postResult.urlcount}개 수집`} | Auction 서버전송: ${transmitStatus}`
  );

  return result;
}
