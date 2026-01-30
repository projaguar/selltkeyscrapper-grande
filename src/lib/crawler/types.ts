/**
 * Crawler 타입 정의
 */

export interface CrawlTask {
  URLNUM: number;
  USERNUM: number;
  URLPLATFORMS: string;
  TARGETSTORENAME: string;
  TARGETURL: string;
  BESTYN: string;
  NEWYN: string;
  SPRICELIMIT: number;
  EPRICELIMIT: number;
}

export interface Session {
  profileId: string;
  profileName: string;
  proxyId?: number;
}

export interface CrawlResult {
  success: boolean;
  urlNum: number;
  storeName: string;
  message?: string;
  error?: string;
  captchaDetected?: boolean;
  todayStop?: boolean;
  data?: CrawlData;
}

export interface CrawlData {
  error: boolean;
  errorMsg: string;
  list: ProductItem[];
}

export interface ProductItem {
  goodscode: string;
  goodsname: string;
  saleprice: number;
  discountsaleprice: number;
  discountrate: number;
  deliveryfee: number;
  nvcate: string;
  imageurl: string;
  goodsurl: string;
  seoinfo: string;
}

export interface BrowserInfo {
  session: Session;
  browser: any; // puppeteer.Browser
  browserData?: any;
  error: string | null;
}

export interface PostData {
  urlnum: number;
  usernum: number;
  spricelimit: number;
  epricelimit: number;
  platforms: string;
  bestyn: string;
  newyn: string;
  result: CrawlData;
}
