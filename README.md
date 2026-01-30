# AdsPower Scrapper

AdsPower Browser를 이용한 네이버 크롤링 자동화 프로그램

## 기술 스택

- **Electron 40** - 데스크톱 앱 프레임워크
- **React 19** - UI 라이브러리
- **Vite 7** - 빌드 도구
- **Bun** - 런타임 및 패키지 매니저
- **TailwindCSS 4** - 스타일링
- **Bun SQLite** - 로컬 데이터베이스 (네이티브)
- **Puppeteer** - 브라우저 자동화
- **Zustand** - 상태 관리
- **TypeScript** - 타입 안전성

## 주요 기능

### 1. 설정 관리
- AdsPower API Key 입력 및 저장
- API 연결 테스트

### 2. Proxy IP 관리
- Proxy 목록 관리 (추가, 수정, 삭제)
- 상태 관리 (활성, 죽음, 사용중)
- 대량 추가 기능 (줄바꿈 형식)
- 통계 대시보드

### 3. AdsPower 프로필 관리
- 프로필 대량 생성 (N개)
- 프로필 대량 삭제
- 프로필 목록 조회
- 프록시 자동 매핑

### 4. 대시보드 (개발 예정)
- 실시간 브라우저 모니터링
- 크롤링 로그
- 성능 통계

## 설치 및 실행

### 사전 요구사항

1. **Bun** 설치
```bash
curl -fsSL https://bun.sh/install | bash
```

2. **AdsPower** 설치 및 실행
- https://www.adspower.com/ko/download
- 유료 계정 필요
- API Key 발급 필요

### 프로젝트 실행

```bash
# 의존성 설치 (이미 완료됨)
bun install

# 개발 모드 실행
bun run dev
```

### 빌드

```bash
# 프로덕션 빌드
bun run build

# Electron 앱 빌드
bun run build:electron
```

## 사용 방법

### 1단계: API Key 설정
1. AdsPower 앱 실행
2. 설정 → Local API → API Key 복사
3. 프로그램 → 설정 메뉴 → API Key 입력 → 저장
4. "연결 테스트" 버튼으로 확인

### 2단계: Proxy 등록
1. Proxy 관리 메뉴
2. "추가" 버튼 또는 "대량 추가" 탭
3. Proxy 정보 입력 (형식: `ip:port:username:password`)

### 3단계: 프로필 생성
1. 프로필 관리 메뉴
2. 생성 개수 입력
3. "N개 생성" 버튼 클릭
4. 자동으로 Proxy가 매핑되어 프로필 생성

### 4단계: 크롤링 (개발 예정)
- 대시보드에서 브라우저 시작
- 실시간 모니터링

## 프로젝트 구조

```
scrapper/
├── electron/              # Electron 메인 프로세스
│   ├── main.ts           # 앱 진입점 (Bun 런타임)
│   └── preload.ts        # IPC 브릿지
├── src/
│   ├── components/       # React 컴포넌트
│   │   ├── Settings/     # 설정 화면
│   │   ├── ProxyManager/ # Proxy 관리
│   │   ├── ProfileManager/ # 프로필 관리
│   │   └── Dashboard/    # 대시보드
│   ├── services/         # 외부 서비스
│   │   └── adspower.ts   # AdsPower API
│   ├── database/         # 데이터베이스
│   │   └── sqlite.ts     # Bun SQLite 관리
│   ├── types/            # TypeScript 타입
│   ├── store.ts          # Zustand 전역 상태
│   └── main.tsx          # React 진입점
├── vite.config.ts        # Vite + Electron 설정
└── package.json
```

## 데이터베이스 스키마

### proxies
```sql
CREATE TABLE proxies (
  id INTEGER PRIMARY KEY,
  ip TEXT NOT NULL,
  port TEXT NOT NULL,
  username TEXT,
  password TEXT,
  status TEXT,  -- active, dead, in_use
  created_at DATETIME
);
```

### settings
```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

## 개발 로드맵

- [x] 프로젝트 초기 세팅
- [x] UI 레이아웃 구성
- [x] 설정 화면
- [x] Proxy 관리 기능
- [x] AdsPower 프로필 관리
- [ ] 브라우저 제어 (Puppeteer)
- [ ] 크롤링 로직
- [ ] 실시간 모니터링
- [ ] 에러 핸들링
- [ ] 로그 시스템

## 라이선스

MIT
