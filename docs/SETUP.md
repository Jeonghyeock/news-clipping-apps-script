# 세팅 가이드

구글 시트를 만들고 스크립트를 붙여 매일 돌게 하고, 홈페이지에 연결하기까지의 순서입니다. 전체 흐름은 [README](../README.md), 설계 판단은 [설계 메모](DESIGN-NOTES.md)에 있습니다.

## 시트 구조

첫 번째 탭의 1행에 아래 열 이름이 있어야 합니다. 열 순서는 상관없습니다(코드가 열 이름으로 위치를 찾습니다). 다른 열을 더 둬도 됩니다.

| 열 | 누가 쓰나 | 내용 |
| --- | --- | --- |
| `status` | 크롤이 `pending`, 이후는 사람 | `pending` / `approved` / `rejected`. 코드는 `pending` 말고는 쓰지 않음 |
| `title`, `date` | 크롤 | 기사 제목, `YYYY.MM.DD` (한국 날짜) |
| `media`, `url` | 크롤, AI가 고침 | 언론사명, 기사 주소. AI가 원문 주소와 정확한 언론사명을 찾으면 덮어씀 |
| `image`, `description` | 사람 (선택) | 홈페이지 카드에 쓸 이미지 주소, 한두 문장 요약 |
| `ai_verdict`, `ai_reason` | AI | 추천(`approve`·`review`·`reject`)과 이유. `status`가 `pending`이고 `ai_verdict`가 비어 있는 행만 검증함 |

## 세팅

### 0. 준비물

- 구글 계정
- Anthropic API 키 ([console.anthropic.com](https://console.anthropic.com) → API Keys, 크레딧 필요)
- 선택: 네이버 검색 API 키, Slack Incoming Webhook, 홈페이지 배포 훅(Vercel 등)
- 홈페이지에 연결할 때: Google Cloud 프로젝트와 서비스 계정 ([7단계](#7-홈페이지에서-승인된-기사-읽기))

### 1. 시트 만들기

1. 새 구글 시트를 만들고 **파일 → 가져오기 → 업로드**로 [`sheet-template.csv`](../sheet-template.csv)를 올린 뒤 "현재 시트 바꾸기"를 고릅니다. (또는 1행에 열 이름을 직접 입력)
2. A열(`status`)을 선택하고 **삽입 → 드롭다운**에서 `pending`, `approved`, `rejected` 세 값을 만듭니다. 승인할 때 고르기 편해집니다.
3. 첫 번째 탭을 씁니다. 다른 탭은 스크립트가 보지 않습니다.
4. `date` 열의 서식은 따로 바꾸지 않아도 됩니다. 스크립트가 새 행을 쓸 때 날짜 칸을 일반 텍스트로 둬서 `2025.03.02` 같은 값이 날짜 값으로 바뀌지 않습니다.

### 2. Apps Script 붙이기

1. 시트에서 **확장 프로그램 → Apps Script**를 엽니다.
2. 편집기의 `Code.gs` 내용을 모두 지우고 [`apps-script/Code.gs`](../apps-script/Code.gs)를 통째로 붙여 넣은 뒤 저장합니다.
3. 왼쪽 **프로젝트 설정(톱니바퀴)**에서 시간대를 `(GMT+09:00) 서울`로 바꿉니다. 매일 실행 시각과 날짜 계산이 이 시간대를 따릅니다.

[clasp](https://github.com/google/clasp)를 쓴다면 `apps-script/` 폴더(`appsscript.json` 포함)를 그대로 push하면 됩니다.

### 3. 설정 블록 고치기

`Code.gs` 위쪽의 **설정** 블록만 우리 회사에 맞게 바꿉니다.

| 값 | 하는 일 | 예시 |
| --- | --- | --- |
| `COMPANY_ABOUT` | AI에게 보여 줄 회사 소개 한 줄. 판단 기준이 된다 | `"샘플테크(SampleTech)는 물류 로봇을 만드는 스타트업이다 (제품: 샘플원)."` |
| `COMPANY_NAMES` | 프롬프트에서 '이 회사'로 부를 이름들 | `"샘플테크/SampleTech/샘플원"` |
| `NOT_US` | 이름이 같거나 비슷하지만 우리가 아닌 곳 (AI용) | `['"샘플테크자산운용"(자산운용사)']` |
| `KEYWORDS` | 검색어. 키워드마다 구글·네이버를 한 번씩 검색 | `["샘플테크", "SampleTech", "샘플원"]` |
| `RELEVANCE` | 제목이나 본문 조각에 이 중 하나가 있어야 후보로 받음 | `[/샘플\s?테크/, /sample\s?tech/i]` |
| `DENY` | 하나라도 있으면 버림 (이름만 같은 회사) | `[/샘플테크\s?자산운용/]` |
| `OLDEST_DATE` | 이 날짜 이전 기사는 받지 않음 (설립일 등) | `"2023.01.01"` |

1차 거르기(`RELEVANCE`, `DENY`)는 넉넉하게 두고, 애매한 것은 AI 검증과 사람이 거르게 하는 편이 기사를 덜 놓칩니다. 다른 단어의 일부로 걸리는 이름은 정규식의 뒤돌아보기로 막을 수 있습니다(예: `/(?<!카사)노바/`는 '카사노바'를 거릅니다).

### 4. 비밀값 넣기 (Script Properties)

**프로젝트 설정 → 스크립트 속성 → 속성 추가**에 넣습니다. 코드에는 키를 쓰지 않습니다.

| 이름 | 필요한 때 | 발급 방법 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | AI 검증 | console.anthropic.com → API Keys → Create Key |
| `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | 선택. 없으면 구글 뉴스만 검색 | [developers.naver.com](https://developers.naver.com) → Application → 애플리케이션 등록 → 사용 API에 **검색** 추가 → Client ID / Client Secret |
| `SLACK_WEBHOOK_URL` | 선택. 없으면 알림 생략 | Slack 앱 만들기 → Incoming Webhooks 켜기 → 채널 선택 → Webhook URL |
| `DEPLOY_HOOK_URL` | 메뉴 '사이트 반영' | Vercel: Project Settings → Git → Deploy Hooks에서 이름·브랜치를 정해 만든 URL (Netlify는 Build hooks) |

네이버 뉴스 API는 원문 주소(`originallink`)와 본문 조각을 함께 줘서, 제목에 회사 이름이 없는 인터뷰·기획 기사까지 잡을 수 있습니다. 가능하면 넣는 것을 권합니다.

### 5. 첫 실행과 권한 승인

1. 시트를 새로고침하면 메뉴에 **뉴스 관리**가 생깁니다.
2. **지금 크롤 실행**을 누르면 권한을 묻습니다. 계정을 고른 뒤 "Google에서 확인하지 않은 앱" 경고가 나오면 **고급 → (프로젝트 이름)(으)로 이동 → 허용**을 누릅니다. 내가 만든 스크립트라서 나오는 경고입니다.
3. 새 후보가 `pending` 행으로 추가되는지 확인하고, **AI 검증**을 눌러 `ai_verdict`·`ai_reason`이 채워지는지 봅니다.
4. **매일 자동 실행 설정**을 한 번 누르면 매일 오전 9~10시에 크롤 → AI 검증 → Slack 요약이 돕니다. 설치된 트리거는 Apps Script 편집기 왼쪽의 시계 아이콘에서 볼 수 있습니다.

### 6. 매일 하는 일: 검토와 게시

1. Slack 요약을 받으면 시트를 열어 `ai_verdict`와 `ai_reason`을 보고 `status`를 `approved` 또는 `rejected`로 바꿉니다.
   - `approve`: 우리 회사가 기사의 주제 (인터뷰, 투자·수상·제품 소식)
   - `review`: 등장은 하지만 주제는 따로 있음 (선정 기업 목록, 참가사 나열 등) — 게시할지 사람이 판단
   - `reject`: 우리 회사가 아니거나 이미 게시한 기사와 같은 기사
2. 필요하면 `image`(대표 이미지 주소)와 `description`(한두 문장)을 채웁니다.
3. 다 골랐으면 **사이트 반영**을 누릅니다. 배포 훅이 홈페이지를 다시 빌드하고, 1~2분 뒤 반영됩니다.

어떤 행을 다시 검증하고 싶으면 `status`가 `pending`인 행의 `ai_verdict`를 비우고(이미 `approved`/`rejected`로 바꿨다면 `status`도 `pending`으로 되돌리고) **AI 검증**을 누릅니다.

### 7. 홈페이지에서 승인된 기사 읽기

시트를 '웹에 게시'해서 읽으면 검토 중인 후보와 AI 판단 이유까지 누구나 볼 수 있습니다. 그래서 시트를 **읽기 전용 서비스 계정**에만 공유하고, 홈페이지를 빌드할 때 그 계정으로 읽습니다.

1. [Google Cloud 콘솔](https://console.cloud.google.com)에서 프로젝트를 만들고 **API 및 서비스 → 라이브러리**에서 **Google Sheets API**를 사용 설정합니다.
2. **IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기**(역할은 주지 않아도 됩니다) → 만든 계정의 **키 → 키 추가 → 새 키 만들기 → JSON**으로 키 파일을 받습니다.
3. 시트의 **공유**에서 서비스 계정 이메일(`...@...iam.gserviceaccount.com`)을 **뷰어**로 추가합니다.
4. 홈페이지 배포 환경(Vercel 프로젝트 설정 등)에 환경 변수를 넣습니다.
   - `NEWS_SHEET_ID`: 시트 주소의 `/d/`와 `/edit` 사이 값
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: 받은 JSON 파일 내용 전체
5. [`site/fetch-approved-news.mjs`](../site/fetch-approved-news.mjs)를 홈페이지 프로젝트의 `scripts/` 폴더에 복사하고 `npm install google-auth-library` 후, 빌드 전에 돌게 합니다.

```json
{
  "scripts": {
    "prebuild": "node scripts/fetch-approved-news.mjs"
  }
}
```

`NEWS_OUTPUT`(기본 `news.json`)에 이런 파일이 생기고, 화면은 이 파일을 읽어 그리면 됩니다. `image`가 빈 행에 쓸 기본 이미지는 `NEWS_FALLBACK_IMAGE`로 정할 수 있습니다.

```json
[
  {
    "title": "샘플테크, 시리즈A 100억 원 유치",
    "media": "한국경제",
    "date": "2025.03.02",
    "url": "https://www.hankyung.com/article/...",
    "image": "https://.../og.jpg",
    "description": "물류 로봇 스타트업 샘플테크가 ..."
  }
]
```

자격 증명이 없거나 시트를 읽지 못하면 빌드를 멈추지 않고 빈 목록을 씁니다(로컬 개발에서도 빌드가 돌도록). 화면에서는 빈 목록일 때 코드에 넣어 둔 기본 목록을 보여 주게 만들어 두면 안전합니다.

> 회사(Google Workspace) 계정에서는 조직 정책으로 서비스 계정 키 만들기가 막혀 있을 수 있습니다. 그때는 관리자에게 해당 프로젝트만 예외를 요청해야 합니다.

## 비용

AI 검증 비용은 기사 1건마다 이렇게 쌓입니다(2026년 10월 공식 가격표 기준).

| 항목 | 가격 | 이 스크립트에서 |
| --- | --- | --- |
| 웹 검색 | 1,000회당 $10 | 기사당 최대 3회(`max_uses: 3`) → 최대 $0.03 |
| 웹 페치 | 추가 요금 없음 | 가져온 페이지는 입력 토큰으로 계산(10kB 페이지 ≈ 2,500토큰) |
| 토큰 (`claude-opus-4-8`) | 100만 토큰당 입력 $5 / 출력 $25 | 프롬프트 + 기존 게시 기사 목록(최대 60개) + 검색 결과 + 가져온 페이지 |

검색 결과와 가져온 페이지가 모두 입력 토큰으로 들어가서, 실제 금액은 기사마다 검색을 몇 번 했고 페이지를 얼마나 읽었는지에 따라 달라집니다. 처음 며칠은 Anthropic Console의 사용량 화면에서 하루 비용을 확인하는 것을 권합니다. 줄이고 싶다면 `max_uses`를 낮추거나, 프롬프트에 넣는 기존 기사 수(`published.slice(0, 60)`)를 줄이면 됩니다.

### 모델 바꾸기

기본값 `claude-opus-4-8`은 `thinking`을 보내지 않으면 생각 단계 없이 답하므로 출력 한도 2,048토큰(`VERIFY_MAX_TOKENS`)으로 충분합니다. Claude Opus 5.5·Sonnet 5.5 같은 최신 모델은 생각 단계가 항상(또는 기본으로) 켜져 있고, 그 토큰도 출력 한도에 포함됩니다. 이런 모델로 바꾸면 `VERIFY_MAX_TOKENS`를 크게(예: 16,000) 올리고, 몇 건을 직접 돌려 응답이 잘리지 않는지 확인하세요. 잘리면 스크립트가 "max_tokens에서 잘렸습니다"라고 알려 줍니다.

웹 검색·웹 페치 도구 버전(`web_search_20260209`, `web_fetch_20260209`)은 Opus 4.6 / Sonnet 4.6 이후 모델용입니다. 그보다 오래된 모델은 `web_search_20250305`, `web_fetch_20250910`을 써야 합니다.
