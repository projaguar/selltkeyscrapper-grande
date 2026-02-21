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
      const hasCloudflareScript = !!window._cf_chl_opt;

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
 * 옥션 상품 데이터 수집
 */
function collectAuctionProducts(modules: any[]): any[] {
  const collectedProducts: any[] = [];

  for (const module of modules) {
    if (!module.rows || !Array.isArray(module.rows)) {
      continue;
    }

    for (const row of module.rows) {
      if (row.designName !== "ItemCardGeneral") {
        continue;
      }

      const viewModel = row.viewModel;
      if (!viewModel) {
        continue;
      }

      // 결제 건수 체크
      const payCountText = viewModel.score?.payCount?.text ?? "0";
      if (payCountText === "0") {
        continue;
      }

      // 가격 정보 추출
      const salePrice = Number(
        (viewModel.price.price?.text ?? "0").replace(/,/g, "")
      );
      const discountsaleprice = viewModel.price.couponDiscountedBinPrice
        ? Number(
            (viewModel.price.couponDiscountedBinPrice ?? "0").replace(/,/g, "")
          )
        : salePrice;
      const discountrate = viewModel.price.discountRate
        ? Number((viewModel.price.discountRate ?? "0").replace(/,/g, ""))
        : 0;

      // 배송비 추출
      let deliveryfee = 0;
      if (viewModel.isFreeDelivery) {
        deliveryfee = 0;
      } else {
        // deliveryTags에서 배송비 확인
        if (viewModel.deliveryTags && Array.isArray(viewModel.deliveryTags)) {
          const deliveryTag = viewModel.deliveryTags.find(
            (tag: any) => tag.text?.text && tag.text.text.includes("배송비")
          );
          if (deliveryTag?.text?.text) {
            const match = deliveryTag.text.text.match(/(\d{1,3}(,\d{3})*)/);
            if (match) {
              deliveryfee = Number(match[0].replace(/,/g, ""));
            }
          }
        }

        // 기존 tags에서 배송비 확인 (폴백)
        if (deliveryfee === 0 && viewModel.tags && Array.isArray(viewModel.tags)) {
          const tag = viewModel.tags.find((tag: string) =>
            tag.startsWith("배송비")
          );
          if (tag) {
            const match = tag.match(/(\d{1,3}(,\d{3})*)/);
            if (match) {
              deliveryfee = Number(match[0].replace(/,/g, ""));
            }
          }
        }
      }

      // 해외직구 여부 확인
      const isOverseas =
        viewModel.sellerOfficialTag?.title?.some(
          (item: any) => item.text === "해외직구"
        ) || false;

      collectedProducts.push({
        goodscode: viewModel.itemNo,
        goodsname: viewModel.item.text,
        imageurl: viewModel.item.imageUrl,
        goodsurl: viewModel.item.link,
        saleprice: salePrice,
        discountsaleprice: discountsaleprice,
        discountrate: discountrate,
        deliveryfee: deliveryfee,
        seoinfo: "",
        nvcate: "",
        isOverseas: isOverseas,
      });
    }
  }

  return collectedProducts;
}

/**
 * 옥션 크롤링
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

  if (!textContent) {
    result.data!.errorMsg = "데이터 로드 실패";
    return outputResult(result, task);
  }

  let data: any;
  try {
    data = JSON.parse(textContent);
  } catch (error) {
    result.data!.errorMsg = "데이터 파싱 실패";
    return outputResult(result, task);
  }

  // 데이터 구조 탐색
  const modules =
    data.props?.pageProps?.initialStates?.curatorData?.regionsData?.content
      ?.modules;

  if (!modules || !Array.isArray(modules)) {
    result.data!.errorMsg = "상품 데이터 없음";
    return outputResult(result, task);
  }

  // 상품 수집
  const collectedProducts = collectAuctionProducts(modules);

  if (collectedProducts.length === 0) {
    result.data!.errorMsg = "상품 없음";
    return outputResult(result, task);
  }

  // 중복 제거
  const uniqueProducts = Array.from(
    collectedProducts
      .reduce((map: any, item: any) => map.set(item.goodscode, item), new Map())
      .values()
  );

  // 해외직구 상품만 필터링
  const overseasProducts = uniqueProducts.filter(
    (item: any) => item.isOverseas === true
  );

  if (overseasProducts.length === 0) {
    result.data!.errorMsg = "국내사업자입니다.";
    return outputResult(result, task);
  }

  // 가격 필터링
  const spricelimit: number = +task.SPRICELIMIT;
  const epricelimit: number = +task.EPRICELIMIT;

  const priceFiltered = overseasProducts.filter(
    (item: any) =>
      item.saleprice >= spricelimit && item.saleprice <= epricelimit
  );

  // 이름 필터링
  const nameFiltered = priceFiltered.filter((item: any) =>
    Boolean(item.goodsname)
  );

  if (nameFiltered.length === 0) {
    result.data!.errorMsg = "가격/이름 필터링 후 상품 없음";
    return outputResult(result, task);
  }

  // 최종 결과
  result.success = true;
  result.data!.error = false;
  result.data!.errorMsg = "수집성공";
  result.data!.list = nameFiltered.map((item: any) => ({
    goodscode: item.goodscode,
    goodsname: item.goodsname,
    saleprice: item.saleprice,
    discountsaleprice: item.discountsaleprice,
    discountrate: item.discountrate,
    deliveryfee: item.deliveryfee,
    nvcate: item.nvcate,
    imageurl: item.imageurl,
    goodsurl: item.goodsurl,
    seoinfo: item.seoinfo,
  }));

  return outputResult(result, task);
}

/**
 * 결과 출력 및 서버 전송
 */
async function outputResult(result: CrawlResult, task: CrawlTask): Promise<CrawlResult> {
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
    `[Auction] ${statusIcon} ${task.TARGETSTORENAME} | ${result.data!.errorMsg} | 상품: ${productCount}개 | Auction 서버전송: ${transmitStatus}`
  );

  return result;
}
