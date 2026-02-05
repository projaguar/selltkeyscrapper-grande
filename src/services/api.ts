/**
 * 서버 API 통신
 */

const API_BASE_URL = 'https://selltkey.com/scb/api';

/**
 * URL 목록 가져오기
 */
export async function getUrlList() {
  try {
    const response = await fetch(`${API_BASE_URL}/getUrlList_adspower.asp`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('[API] JSON 파싱 오류 - 서버 원본 응답:');
      console.error('='.repeat(50));
      console.error(text);
      console.error('='.repeat(50));
      throw parseError;
    }

    // 서버 응답: { inserturl: "...", item: [...] }
    return {
      inserturl: data.inserturl || '',
      item: data.item || []
    };
  } catch (error: any) {
    console.error('[API] Failed to get URL list:', error);
    throw error;
  }
}
