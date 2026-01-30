# Proxy Management Scripts

프록시 IP를 관리하기 위한 CLI 스크립트입니다.

## 스크립트 목록

### 1. 프록시 가져오기 (Import)
`_resource/프록시유동_모모아이피.txt` 파일에서 프록시 목록을 읽어서 데이터베이스에 추가합니다.

```bash
bun run proxy:import
```

### 2. 전체 프록시 삭제 (Delete)
데이터베이스에 있는 모든 프록시를 삭제합니다.

```bash
bun run proxy:delete
```

### 3. 프록시 갱신 (Refresh)
기존 프록시를 모두 삭제하고 새로운 프록시 목록을 가져옵니다.

```bash
bun run proxy:refresh
```

## 월간 프록시 갱신 작업

매달 새로운 프록시 목록을 받으면 다음과 같이 진행하세요:

1. `_resource/프록시유동_모모아이피.txt` 파일을 새로운 프록시 목록으로 교체
2. 아래 명령어 실행:
   ```bash
   bun run proxy:refresh
   ```

## 프록시 파일 형식

프록시 파일은 다음 형식을 따라야 합니다:
```
IP:PORT
IP:PORT
...
```

예시:
```
121.126.107.161:6327
121.126.53.42:5550
202.126.113.149:5522
```

## 데이터베이스 위치

macOS: `~/Library/Application Support/scrapper/data.db`
Windows: `%APPDATA%/scrapper/data.db`
Linux: `~/.config/scrapper/data.db`

## 문제 해결

### Node.js 모듈 버전 오류 발생 시
```bash
npm rebuild better-sqlite3
```
