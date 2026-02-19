/**
 * 네이버 크롤링 로직
 */

import type { CrawlTask, CrawlResult } from "../types";
import { postGoodsList } from "../task-manager";

/**
 * CAPTCHA 감지
 */
export async function detectNaverCaptcha(page: any): Promise<boolean> {
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
    console.log(`[Naver] CAPTCHA check error:`, error);
    return false;
  }
}

/**
 * 네이버 상품 데이터 수집
 */
function collectNaverProducts(data: any, targetList: number[]): any[] {
  try {
    const targetSet = new Set(targetList);
    const widgetContents = data?.widgetContents || {};
    const category = data?.category || {};

    const sources = {
      REALTIME:
        widgetContents.bestProductWidget?.A?.data?.bestProducts?.REALTIME
          ?.simpleProducts || [],
      DAILY:
        widgetContents.bestProductWidget?.A?.data?.bestProducts?.DAILY
          ?.simpleProducts || [],
      WEEKLY:
        widgetContents.bestProductWidget?.A?.data?.bestProducts?.WEEKLY
          ?.simpleProducts || [],
      MONTHLY:
        widgetContents.bestProductWidget?.A?.data?.bestProducts?.MONTHLY
          ?.simpleProducts || [],
      allCategory:
        widgetContents?.bestProductWidget?.A?.data?.allCategoryProducts
          ?.simpleProducts || [],
      bestReview:
        widgetContents?.bestReviewWidget?.A?.data?.reviewProducts || [],
      wholeProduct:
        widgetContents?.wholeProductWidget?.A?.data?.simpleProducts || [],
      category: category?.A?.simpleProducts || [],
    };

    // 각 소스에서 매칭되는 상품 찾기
    const combinedFound = Object.values(sources)
      .flat()
      .filter((item: any) => targetSet.has(item.id));

    // 중복 제거
    const uniqueById = Array.from(
      combinedFound
        .filter((item: any) => item && item.id)
        .reduce((map: any, item: any) => map.set(item.id, item), new Map())
        .values()
    );

    console.log(
      `[Naver] Collected ${uniqueById.length} products (target: ${targetList.length})`
    );

    return uniqueById;
  } catch (error) {
    console.error("[Naver] Product collection error:", error);
    return [];
  }
}

/**
 * 네이버 크롤링
 */
export async function crawlNaver(
  page: any,
  task: CrawlTask,
  profileName: string
): Promise<CrawlResult> {
  // CAPTCHA 체크
  if (await detectNaverCaptcha(page)) {
    console.log(`[Naver] ${profileName} - CAPTCHA detected!`);
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

  // 데이터 유효성 검사
  if (!data) {
    result.data!.errorMsg = "데이터 로드 실패";
  } else if (
    !data.categoryTree?.A ||
    Object.keys(data.categoryTree?.A).length === 0
  ) {
    result.data!.errorMsg = "운영중이 아님";
  } else {
    // 베스트/신상품 필터링
    const bestList =
      data.smartStoreV2?.specialProducts?.bestProductNos ?? [];
    const newList = data.smartStoreV2?.specialProducts?.newProductNos ?? [];
    const targetList = [
      ...(task.BESTYN === "Y" ? bestList : []),
      ...(task.NEWYN === "Y" ? newList : []),
    ];

    if (targetList.length === 0) {
      result.data!.errorMsg = "베스트 상품이 없음";
    } else {
      // 상품 데이터 수집 및 필터링
      const combinedFound = collectNaverProducts(data, targetList);

      if (combinedFound.length === 0) {
        result.data!.errorMsg = "수집된 상품 데이터 없음";
      } else {
        const spricelimit: number = +task.SPRICELIMIT;
        const epricelimit: number = +task.EPRICELIMIT;

        // 가격 필터링
        const priceFiltered = combinedFound.filter(
          (item: any) =>
            item.salePrice >= spricelimit && item.salePrice <= epricelimit
        );

        // 이름 필터링
        const nameFiltered = priceFiltered.filter((item: any) =>
          Boolean(item.name)
        );

        if (nameFiltered.length === 0) {
          result.data!.errorMsg = "가격/이름 필터링 후 상품 없음";
        } else {
          result.success = true;
          result.data!.error = false;
          result.data!.errorMsg = "수집성공";
          result.data!.list = nameFiltered.map((item: any) => ({
            goodscode: item.id,
            goodsname: item.name,
            saleprice: item.salePrice,
            discountsaleprice:
              item.benefitsView?.discountedSalePrice || item.salePrice,
            discountrate: item.benefitsView?.discountedRatio || 0,
            deliveryfee: item.productDeliveryInfo?.baseFee ?? 0,
            nvcate: item.category?.categoryId || "",
            imageurl: item.representativeImageUrl || "",
            goodsurl: `https://smartstore.naver.com/${data.smartStoreV2?.channel?.url || "unknown"}/products/${item.id}`,
            seoinfo: data.seoInfo?.sellerTags ?? "",
          }));
        }
      }
    }
  }

  // 서버에 데이터 전송
  const postData = {
    urlnum: task.URLNUM,
    usernum: task.USERNUM,
    spricelimit: task.SPRICELIMIT,
    epricelimit: task.EPRICELIMIT,
    platforms: task.URLPLATFORMS,
    bestyn: task.BESTYN,
    newyn: task.NEWYN,
    result: result.data || { error: true, errorMsg: "", list: [] },
  };

  const postResult = await postGoodsList(postData);
  result.todayStop = postResult.todayStop;
  result.serverTransmitted = postResult.success;

  // 서버 전송 결과 출력
  const statusIcon = result.success ? "✓" : "✗";
  const productCount = result.data!.list.length;
  const transmitStatus = postResult.success ? (postResult.todayStop ? "중단" : "완료") : "실패";
  console.log(
    `[Naver] ${statusIcon} ${task.TARGETSTORENAME} | ${result.data!.errorMsg} | 상품: ${productCount}개 | Naver 서버전송: ${transmitStatus}`
  );

  return result;
}
