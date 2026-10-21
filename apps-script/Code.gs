/**
 * 구글 시트에 붙여 쓰는 뉴스 수집 + AI 검증 스크립트.
 * 서버도, GitHub Actions도, Node도 없이 시트 안에서 전부 돈다.
 *
 *   • 지금 크롤 실행      — 구글 뉴스·네이버 뉴스를 검색해 새 후보를 pending 행으로 추가
 *   • AI 검증            — pending 행을 Claude(웹 검색)로 확인해 ai_verdict / ai_reason 을 채움
 *   • 매일 자동 실행 설정  — 매일 아침 크롤 → AI 검증 → Slack 요약을 도는 트리거 설치
 *   • 사이트 반영         — 배포 훅을 불러 홈페이지를 다시 빌드 (승인된 행이 반영됨)
 *
 * 세팅 방법은 README.md 를 본다. 우리 회사에 맞게 고칠 곳은 아래 "설정" 블록뿐이다.
 * 비밀값(API 키, 웹훅 주소)은 코드에 쓰지 않고 Script Properties 에 넣는다.
 */

// 다른 모델로 바꿀 때는 README 의 "모델 바꾸기"를 먼저 본다(thinking 이 켜지는 모델은 VERIFY_MAX_TOKENS 를 올려야 한다).
const MODEL = "claude-opus-4-8";
const MAX_VERIFY_PER_RUN = 6; // cap AI calls per run (Apps Script ~6-min limit)
const VERIFY_TIME_LIMIT_MS = 4.5 * 60 * 1000; // 실행이 이만큼 지나면 새 행을 시작하지 않는다 (한 행이 1분 넘게 걸리기도 한다)
const VERIFY_MAX_TOKENS = 2048; // 한 행을 검증하는 응답의 출력 한도
const MAX_VERIFY_TURNS = 4; // web 검색이 pause_turn 으로 끊길 때 이어서 보낼 최대 턴 수
// 시트에 있어야 하는 열 이름. 순서는 시트의 1행이 정하므로 여기 순서에 의존하지 않는다
// (사람이 열을 옮길 수 있다). 읽기·쓰기는 모두 headerIndex_ 로 얻은 위치를 쓴다.
const COLUMNS = [
  "status", "title", "media", "date", "url",
  "image", "description", "ai_verdict", "ai_reason",
];

// ==== 설정: 우리 회사에 맞게 이 블록만 고친다 ==================================
// (아래 값은 예시다. 실제 회사 이름·제품명으로 바꾼다.)

// AI에게 보여 줄 회사 소개 한 줄. "우리 회사 기사인가"를 판단하는 기준이 된다.
const COMPANY_ABOUT = "샘플테크(SampleTech)는 물류 로봇을 만드는 스타트업이다 (제품: 샘플원/SampleOne).";
// 프롬프트에서 '이 회사'로 부를 이름들
const COMPANY_NAMES = "샘플테크/SampleTech/샘플원";
// 이름이 같거나 비슷하지만 우리가 아닌 곳. AI가 동명이의 기사를 걸러내는 데 쓴다. 없으면 [].
const NOT_US = ['"샘플테크자산운용"(자산운용사)'];
// 검색어. 키워드마다 구글 뉴스와 네이버 뉴스를 한 번씩 검색한다.
const KEYWORDS = ["샘플테크", "SampleTech", "샘플원"];
// 제목(없으면 네이버가 주는 본문 조각)에 이 중 하나가 있어야 후보로 받는다.
// 다른 단어의 일부로 걸리면 뒤돌아보기로 막는다. 예: /(?<!카사)노바/ 는 '카사노바'를 거른다.
const RELEVANCE = [/샘플\s?테크/, /sample\s?tech/i, /샘플원/];
// 이 중 하나라도 있으면 버린다(이름만 같은 다른 회사).
const DENY = [/샘플테크\s?자산운용/];
// 이 날짜 이전 기사는 우리 회사일 수 없다(회사 설립일 등) — 동명이의 검색 결과일 뿐이다.
// 날짜 형식이 "YYYY.MM.DD" 로 0 패딩돼 있어 문자열 비교로 충분하다.
const OLDEST_DATE = "2023.01.01";
// ==========================================================================

const USE_GOOGLE = true; // Google News RSS (no key)
const USE_NAVER = true; // Naver News API (needs NAVER_CLIENT_ID/SECRET; skipped if absent)

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("뉴스 관리")
    .addItem("지금 크롤 실행", "crawlNews")
    .addItem("AI 검증 (pending 보강)", "verifyPending")
    .addSeparator()
    .addItem("매일 자동 실행 설정 (크롤+검증)", "setupDailyTrigger")
    .addSeparator()
    .addItem("사이트 반영 (재빌드)", "triggerDeploy")
    .addToUi();
}

// ---- daily trigger --------------------------------------------------------

function setupDailyTrigger() {
  const ui = SpreadsheetApp.getUi();
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "dailyRun") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("dailyRun").timeBased().atHour(9).everyDays(1).create();
  ui.alert(
    "매일 자동 실행을 켰습니다 (오전 9~10시 사이, 스크립트 시간대 기준).\n" +
      "프로젝트 설정의 시간대가 Asia/Seoul인지 확인하세요."
  );
}

// Trigger target: crawl, then verify, then one Slack summary. Runs headless.
function dailyRun() {
  const startedAt = Date.now();
  const sheet = firstSheet_();
  const added = crawlCore_(sheet);
  const counts = verifyCore_(sheet, startedAt);
  const pendingTotal = countPending_(firstSheet_());
  const issue = verifyIssueNote_(counts);
  notifySlack_(
    (issue ? ":warning: AI 검증 문제 — " + issue + "\n" : "") +
      ":newspaper: 뉴스 자동 실행 완료 — 새 후보 " +
      added +
      "건 수집, AI 검증 " +
      counts.done +
      "건 (승인추천 " +
      counts.approve +
      " / 반려 " +
      counts.reject +
      " / 확인필요 " +
      counts.review +
      "). 검토 대기 총 " +
      pendingTotal +
      "건." +
      (counts.remaining
        ? " (시간 제한상 미검증 " + counts.remaining + "건은 다음 자동 실행 때 이어서 검증)"
        : "") +
      confirmCta_(pendingTotal)
  );
}

// ---- crawl ---------------------------------------------------------------

function crawlNews() {
  const ui = SpreadsheetApp.getUi();
  let added;
  try {
    added = crawlCore_(firstSheet_());
  } catch (e) {
    ui.alert("크롤을 중단했습니다.\n\n" + e.message);
    return;
  }
  const pendingTotal = countPending_(firstSheet_());
  notifySlack_(
    added > 0
      ? ":newspaper: 새 뉴스 후보 " + added + "건 수집 (검토 대기 총 " + pendingTotal + "건)." +
          confirmCta_(pendingTotal)
      : ":white_check_mark: 크롤 완료 — 새 후보 없음 (검토 대기 총 " + pendingTotal + "건)." +
          confirmCta_(pendingTotal)
  );
  ui.alert("크롤 완료 — 새 후보 " + added + "건 추가.");
}

// Fetch, filter, dedupe, append, sort. Returns number of rows added.
function crawlCore_(sheet) {
  const data = sheet.getDataRange().getValues();
  const col = headerIndex_(data[0]);
  // 열 이름이 틀린 채로 돌면 그 열이 빈 행이 쌓인다(url 이 없으면 중복 검사도 안 걸린다).
  const missing = missingColumnsNote_(col);
  if (missing) throw new Error(missing);

  // A row is a duplicate if its normalized title OR its URL matches an
  // existing/seen row. Title and url are stable; media is NOT part of the key
  // because AI verify rewrites the media name after the crawl, which would
  // otherwise make the same article look "new" on the next crawl.
  const titleKey = (title) => "t:" + normTitle_(title);
  const urlKey = (url) => "u:" + url;
  const seen = {};
  for (let r = 1; r < data.length; r++) {
    // 시트에 저장된 URL 에는 예전에 들어온 추적 파라미터가 남아 있을 수 있다.
    // 새로 크롤한 URL 과 같은 기준으로 맞춰야 중복 검사가 실제로 걸린다.
    const u = data[r][col.url];
    if (u) seen[urlKey(cleanUrl_(u))] = true;
    if (normTitle_(data[r][col.title])) seen[titleKey(data[r][col.title])] = true;
  }

  const fresh = [];
  KEYWORDS.forEach((kw) => {
    const items = [];
    if (USE_GOOGLE) items.push.apply(items, fetchGoogleNews_(kw));
    if (USE_NAVER) items.push.apply(items, fetchNaverNews_(kw));
    items.forEach((item) => {
      item.url = cleanUrl_(item.url);
      if (!isRecentEnough_(item.date)) return;
      if (!isRelevant_(item.title, item.snippet)) return;
      if (!normTitle_(item.title)) return;
      const tk = titleKey(item.title);
      const u = item.url ? urlKey(item.url) : null;
      if (seen[tk] || (u && seen[u])) return;
      seen[tk] = true;
      if (u) seen[u] = true;
      fresh.push(item);
    });
  });

  if (fresh.length) {
    // 값을 열 이름으로 정하고, 자리는 시트 1행의 실제 순서(col)에 맞춘다.
    const width = data[0].length;
    const rows = fresh.map((it) => {
      const row = new Array(width).fill("");
      const put = (name, value) => {
        if (col[name] !== undefined) row[col[name]] = value;
      };
      put("status", "pending");
      put("title", it.title);
      put("media", it.media);
      put("date", it.date);
      put("url", it.url);
      return row;
    });
    sheet
      .getRange(sheet.getLastRow() + 1, 1, rows.length, width)
      .setValues(rows);
    sortByDateDesc_(sheet, col);
  }
  return fresh.length;
}

function fetchGoogleNews_(keyword) {
  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(keyword) +
    "&hl=ko&gl=KR&ceid=KR:ko";
  const out = [];
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return out;
    const items = XmlService.parse(res.getContentText())
      .getRootElement()
      .getChild("channel")
      .getChildren("item");
    items.forEach((it) => {
      const rawTitle = it.getChildText("title") || "";
      const srcEl = it.getChild("source");
      const media = srcEl ? srcEl.getText() : "";
      out.push({
        title: cleanTitle_(rawTitle, media),
        url: it.getChildText("link") || "",
        media: media,
        date: toDateKST_(it.getChildText("pubDate")),
        // 구글 RSS 의 description 은 링크 마크업뿐이라 본문 판정에 쓸 수 없다
        snippet: "",
      });
    });
  } catch (e) {
    // ignore a single keyword's failure
  }
  return out;
}

// Naver News API — returns the real article URL (originallink) directly, so
// verify can read the real article without resolving a redirect.
function fetchNaverNews_(keyword) {
  const id = prop_("NAVER_CLIENT_ID");
  const secret = prop_("NAVER_CLIENT_SECRET");
  if (!id || !secret) return []; // not configured → skip
  const url =
    "https://openapi.naver.com/v1/search/news.json?query=" +
    encodeURIComponent(keyword) +
    "&display=30&sort=date";
  const out = [];
  try {
    const res = UrlFetchApp.fetch(url, {
      headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) return out;
    (JSON.parse(res.getContentText()).items || []).forEach((it) => {
      const link = it.originallink || it.link || "";
      out.push({
        title: stripHtml_(it.title),
        url: link,
        media: mediaFromUrl_(link),
        date: toDateKST_(it.pubDate),
        // 검색어가 본문에서 매칭된 부분 — 제목에 회사명이 없는 기사를 살리는 근거
        snippet: stripHtml_(it.description),
      });
    });
  } catch (e) {
    // ignore a single keyword's failure
  }
  return out;
}

function stripHtml_(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Naver gives no clean press name — map common hosts, fall back to hostname.
function mediaFromUrl_(url) {
  try {
    const host = url.split("/")[2].replace(/^www\./, "");
    const MAP = {
      "chosun.com": "조선일보",
      "biz.chosun.com": "조선비즈",
      "donga.com": "동아일보",
      "joongang.co.kr": "중앙일보",
      "hankyung.com": "한국경제",
      "mk.co.kr": "매일경제",
      "mt.co.kr": "머니투데이",
      "yna.co.kr": "연합뉴스",
      "zdnet.co.kr": "지디넷코리아",
      "etnews.com": "전자신문",
      "inews24.com": "아이뉴스24",
      "aitimes.com": "AI타임스",
      "heraldcorp.com": "헤럴드경제",
      "asiae.co.kr": "아시아경제",
      "platum.kr": "플래텀",
      "venturesquare.net": "벤처스퀘어",
      "irobotnews.com": "로봇신문",
      "tech42.co.kr": "테크42",
      "wowtale.net": "와우테일",
    };
    return MAP[host] || host;
  } catch (e) {
    return "";
  }
}

// 두 소스 모두 pubDate 를 UTC 로 비교 가능한 형태로 준다. 한국(KST) 기준 날짜로
// 맞춰야 09:00 KST 이전에 나온 기사가 하루 앞선 날짜로 저장되지 않는다 —
// 그렇게 되면 OLDEST_DATE 하한선에 걸려 설립 이전 기사로 버려진다.
function toDateKST_(pubDate) {
  if (!pubDate) return "";
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return "";
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const m = ("0" + (kst.getUTCMonth() + 1)).slice(-2);
  const day = ("0" + kst.getUTCDate()).slice(-2);
  return kst.getUTCFullYear() + "." + m + "." + day;
}

// 설립 이전 기사를 걸러낸다. 날짜를 못 읽은 건은 버리지 않고 사람이 보게 남긴다.
function isRecentEnough_(date) {
  const d = String(date || "");
  if (!d) return true;
  return d >= OLDEST_DATE;
}

// 제목 우선, 없으면 검색 스니펫(본문 일부)으로 판정한다.
// 인터뷰·기획 기사는 제목에 회사명이 없는 경우가 많아 제목만 보면 대부분 놓친다.
// 스니펫은 네이버 뉴스 API가 주는 본문 조각이며, DENY도 같이 적용해
// 본문에만 등장하는 동명 회사도 함께 걸러낸다.
function isRelevant_(title, snippet) {
  const t = title || "";
  if (DENY.some((re) => re.test(t))) return false;
  if (RELEVANCE.some((re) => re.test(t))) return true;

  const s = snippet || "";
  if (!s) return false;
  if (DENY.some((re) => re.test(s))) return false;
  return RELEVANCE.some((re) => re.test(s));
}

function cleanTitle_(title, media) {
  if (media && title.slice(-(media.length + 3)) === " - " + media) {
    return title.slice(0, -(media.length + 3)).trim();
  }
  return title.trim();
}

// 네이버가 돌려주는 원문 링크에는 유입경로 추적 파라미터가 붙어 오는 경우가 있다.
// 그대로 두면 같은 기사가 "utm 붙은 URL"과 "안 붙은 URL"로 서로 다르게 취급돼
// 중복 검사를 빠져나간다(실제로 그렇게 같은 기사가 두 번 들어온 적이 있다).
// 기사 식별에 쓰이는 파라미터(idxno, key, no, CNTN_CD 등)는 건드리지 않고,
// 아래 목록의 추적용 키만 제거한다.
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "igshid",
  "input",        // 연합뉴스
  "lfrom",        // 네이버/카카오 공유
  "wlog_tag3",    // 서울신문
];

function cleanUrl_(url) {
  const u = String(url || "");
  const q = u.indexOf("?");
  if (q < 0) return u;
  const base = u.slice(0, q);
  const hashAt = u.indexOf("#", q);
  const hash = hashAt >= 0 ? u.slice(hashAt) : "";
  const query = u.slice(q + 1, hashAt >= 0 ? hashAt : undefined);
  const kept = query
    .split("&")
    .filter(function (pair) {
      if (!pair) return false;
      const key = pair.split("=")[0];
      return TRACKING_PARAMS.indexOf(key) < 0;
    });
  return base + (kept.length ? "?" + kept.join("&") : "") + hash;
}

function normTitle_(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sortByDateDesc_(sheet, col) {
  const last = sheet.getLastRow();
  if (last < 3) return;
  sheet
    .getRange(2, 1, last - 1, sheet.getLastColumn())
    .sort({ column: col.date + 1, ascending: false });
}

// ---- AI 검증 -------------------------------------------------------------

function verifyPending() {
  const ui = SpreadsheetApp.getUi();
  if (!prop_("ANTHROPIC_API_KEY")) {
    ui.alert("Script Properties에 ANTHROPIC_API_KEY를 먼저 넣어주세요.");
    return;
  }
  const counts = verifyCore_(firstSheet_());
  if (counts.error) {
    const note =
      "AI 검증을 중단했습니다.\n\n" +
      counts.error +
      "\n\n" +
      (counts.done ? counts.done + "건은 검증을 마쳤습니다. " : "실패한 행에는 아무것도 쓰지 않았습니다. ") +
      "원인을 해결한 뒤 다시 실행하면 중단된 행부터 이어서 검증합니다.";
    notifySlack_(":warning: 뉴스 AI 검증 중단 — " + counts.error);
    ui.alert(note);
    return;
  }
  if (counts.done === 0) {
    ui.alert(
      counts.skipped || counts.deferred
        ? "검증에 성공한 항목이 없습니다. " + verifyIssueNote_(counts)
        : "검증할 새 항목이 없습니다 (pending 중 미검증 건이 없음)."
    );
    return;
  }
  const summary =
    "AI 검증 완료 — " +
    counts.done +
    "건 (승인추천 " +
    counts.approve +
    " / 반려 " +
    counts.reject +
    " / 확인필요 " +
    counts.review +
    ")" +
    (counts.remaining
      ? (counts.timedOut
          ? ". 실행 시간 제한(약 6분)에 가까워져 중간에 멈췄습니다"
          : ". 실행 시간 제한(약 6분)으로 한 번에 최대 " + MAX_VERIFY_PER_RUN + "건만 검증합니다") +
        " — 남은 " +
        counts.remaining +
        "건은 다시 실행해주세요."
      : "");
  const issue = verifyIssueNote_(counts);
  const full = summary + (issue ? " ⚠ " + issue : "");
  notifySlack_(":mag: 뉴스 " + full + confirmCta_(countPending_(firstSheet_())));
  ui.alert(full);
}

// Verify up to MAX_VERIFY_PER_RUN pending rows. Returns counts. No Slack.
// startedAt 은 이번 실행이 시작된 시각이다. 매일 실행은 크롤에 쓴 시간도 6분 제한에 들어가서 넘겨준다.
function verifyCore_(sheet, startedAt) {
  const started = startedAt || Date.now();
  const key = prop_("ANTHROPIC_API_KEY");
  const counts = {
    done: 0, approve: 0, reject: 0, review: 0, remaining: 0,
    skipped: 0, deferred: 0, deferredNote: "", error: "", timedOut: false,
  };
  if (!key) return counts;
  const data = sheet.getDataRange().getValues();
  const col = headerIndex_(data[0]);
  // 결과를 쓸 열이 없으면 API 를 부르기 전에 멈춘다. 알림은 verifyPending·dailyRun 이 counts.error 로 한다.
  counts.error = missingColumnsNote_(col);
  if (counts.error) return counts;

  // Only verify pending rows that aren't verified yet (empty ai_verdict), so
  // we don't re-spend on / overwrite already-verified rows. To re-verify a row,
  // clear its ai_verdict cell.
  const pending = [];
  for (let r = 1; r < data.length; r++) {
    const isPending = String(data[r][col.status] || "").toLowerCase() === "pending";
    const notVerified = !String(data[r][col.ai_verdict] || "").trim();
    if (isPending && notVerified) pending.push(r);
  }
  const rows = pending.slice(0, MAX_VERIFY_PER_RUN);

  // Reference set for duplicate detection: already-published (approved) rows,
  // so the AI can catch the same story crawled under a slightly different title.
  const published = [];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][col.status] || "").toLowerCase() === "approved") {
      published.push({
        title: data[r][col.title],
        media: data[r][col.media],
        date: data[r][col.date],
      });
    }
  }

  for (let i = 0; i < rows.length; i++) {
    // 약 6분을 넘으면 Apps Script 가 실행을 강제로 끊어 Slack 요약도 가지 않는다.
    // 시간이 얼마 안 남았으면 새 행을 시작하지 않고 남은 행은 다음 실행으로 넘긴다.
    if (Date.now() - started > VERIFY_TIME_LIMIT_MS) {
      counts.timedOut = true;
      break;
    }
    const r = rows[i];
    const result = verifyOne_(
      key,
      {
        title: data[r][col.title],
        media: data[r][col.media],
        date: data[r][col.date],
        url: data[r][col.url],
      },
      published
    );

    // 호출이 실패하면 시트에 아무것도 쓰지 않는다. ai_verdict 를 비워 둬야
    // 다음 실행에서 이 행을 다시 검증한다 (채우면 검증된 것으로 보고 영영 건너뛴다).
    // 400 같은 요청 오류는 남은 행에서도 똑같이 실패하므로 즉시 중단하지만,
    // 429·5xx 처럼 잠시 뒤 풀릴 오류로 나머지 행의 몫까지 버리지는 않는다.
    if (result.error) {
      if (!result.retryable) {
        counts.error = result.error;
        break;
      }
      counts.deferred++;
      counts.deferredNote = result.error;
      continue;
    }
    // 응답을 못 읽은 행은 비워 둔 채 건너뛰고 다음 행을 계속한다.
    if (result.unparsed) {
      counts.skipped++;
      continue;
    }

    let verdict = result.verdict;
    let reason = result.reason || "";
    if (result.ours === false && verdict !== "reject") {
      verdict = "reject";
      reason = "우리 회사 기사가 아님 — " + reason;
    }
    if (result.duplicate) {
      verdict = "reject";
      reason = "기존 게시 기사와 중복 — " + reason;
    }
    counts[verdict] = (counts[verdict] || 0) + 1;
    counts.done++;

    const sheetRow = r + 1;
    setCell_(sheet, sheetRow, col.ai_verdict, verdict);
    setCell_(sheet, sheetRow, col.ai_reason, reason);
    // 모델이 리다이렉트를 풀어 준 URL 에도 추적 파라미터가 붙어 있다.
    // 크롤과 같은 기준으로 정리해 둬야 다음 크롤에서 중복 검사에 걸린다.
    if (result.url) setCell_(sheet, sheetRow, col.url, cleanUrl_(result.url));
    if (result.media) setCell_(sheet, sheetRow, col.media, result.media);
    // status(게시 여부)는 사람이 정하는 칸이라 코드가 쓰지 않는다.
    // 판단 근거는 ai_verdict / ai_reason 에만 남긴다.
  }
  counts.remaining = Math.max(0, pending.length - counts.done);
  return counts;
}

// 검증이 정상적으로 끝나지 않았을 때 사람에게 보여줄 한 줄. 정상이면 빈 문자열.
function verifyIssueNote_(counts) {
  const parts = [];
  if (counts.error) parts.push(counts.error + " — 해당 행은 비워 두었으니 다시 실행하면 이어서 검증합니다");
  if (counts.deferred)
    parts.push(
      "일시적 오류로 건너뛴 " + counts.deferred + "건은 다음 실행 때 재시도합니다" +
        (counts.deferredNote ? " (" + counts.deferredNote + ")" : "")
    );
  if (counts.skipped) parts.push("응답을 읽지 못해 건너뛴 " + counts.skipped + "건은 다음 실행 때 재시도합니다");
  return parts.join(" / ");
}

// web_search / web_fetch 를 쓰는 턴은 도구가 다 돌기 전에 pause_turn 으로 끊겨
// 돌아온다. 받은 턴을 그대로 되돌려주며 이어가야 마지막 JSON 답변을 받는다.
// 이어가지 않으면 본문이 중간에서 끝나 파싱만 실패하고, 그 행은 ai_verdict 가
// 빈 채로 남아 매 실행마다 다시 뽑혀 같은 실패를 반복한다.
function verifyOne_(key, row, published) {
  const messages = [{ role: "user", content: buildPrompt_(row, published) }];
  let text = "";
  let paused = false;

  for (let turn = 0; turn < MAX_VERIFY_TURNS; turn++) {
    // muteHttpExceptions 는 HTTP 상태 오류만 막는다. DNS 실패·시간 초과는 예외로 나오는데,
    // 밖으로 나가면 실행 전체가 죽어 남은 행도, Slack 요약도 없다. 429·5xx 처럼 이 행만 미룬다.
    let res;
    try {
      res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
        method: "post",
        contentType: "application/json",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        payload: JSON.stringify({
          model: MODEL,
          max_tokens: VERIFY_MAX_TOKENS,
          tools: [
            { type: "web_search_20260209", name: "web_search", max_uses: 3 },
            { type: "web_fetch_20260209", name: "web_fetch", max_uses: 2 },
          ],
          messages: messages,
        }),
        muteHttpExceptions: true,
      });
    } catch (err) {
      return { error: "API 호출 실패(네트워크 오류·시간 초과) — " + err.message, retryable: true };
    }
    const code = res.getResponseCode();
    if (code !== 200) {
      return { error: apiErrorMessage_(res), retryable: isRetryable_(code) };
    }

    // 200 이어도 본문이 JSON 이 아닐 수 있다 (프록시 오류 페이지, 잘린 응답).
    // 여기서 예외가 밖으로 나가면 실행 전체가 죽어 Slack 알림조차 가지 않는다.
    let body;
    try {
      body = JSON.parse(res.getContentText());
    } catch (err) {
      return { error: "API 응답 본문을 읽지 못했습니다 (HTTP 200)", retryable: true };
    }

    // 마지막 턴의 텍스트에만 최종 JSON 이 들어 있다 — 중간 턴의 말은 섞지 않는다.
    text = "";
    (body.content || []).forEach((b) => {
      if (b.type === "text" && b.text) text += b.text;
    });

    // 출력이 잘리면 JSON 이 중간에서 끝나 파싱만 실패한다. 설정 문제이므로
    // "읽지 못했다"로 뭉뚱그리지 않고 올려야 할 값을 그대로 알려준다.
    if (body.stop_reason === "max_tokens") {
      return {
        error: "모델 응답이 max_tokens(" + VERIFY_MAX_TOKENS + ")에서 잘렸습니다 — 값을 올려주세요",
        retryable: false,
      };
    }
    // 모델이 판단을 거절하면 본문이 비어 파싱만 실패하고, 그 행이 매 실행마다 다시 뽑힌다.
    // 사람이 보도록 review 로 남겨 반복을 끊는다.
    if (body.stop_reason === "refusal") {
      return { ours: true, verdict: "review", reason: "AI가 이 기사의 판단을 거절함 — 사람이 직접 확인", url: "", media: "", duplicate: false };
    }
    paused = body.stop_reason === "pause_turn";
    if (!paused) break;
    messages.push({ role: "assistant", content: body.content });
  }

  if (paused) {
    return {
      error: "검색 턴이 " + MAX_VERIFY_TURNS + "회 안에 끝나지 않았습니다 — MAX_VERIFY_TURNS 를 올려주세요",
      retryable: false,
    };
  }

  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return {
      ours: parsed.ours !== false,
      verdict:
        ["approve", "reject", "review"].indexOf(parsed.verdict) >= 0 ? parsed.verdict : "review",
      reason: parsed.reason || "",
      url: parsed.url || "",
      media: parsed.media || "",
      duplicate: parsed.duplicate === true,
    };
  } catch (err) {
    return { unparsed: true };
  }
}

// 혼잡·속도 제한·일시 장애는 잠시 뒤 다시 하면 풀린다. 400/401/403/404 처럼
// 요청 자체가 잘못된 오류는 남은 행에서도 똑같이 실패하므로 구분해야 한다.
function isRetryable_(code) {
  return code === 408 || code === 429 || code >= 500;
}

// 오류 본문에 실제 원인이 들어 있다 (모델명 오타, 크레딧 부족, 권한 등).
// 상태 코드만으로는 무엇이 잘못됐는지 알 수 없어 메시지까지 함께 보여준다.
function apiErrorMessage_(res) {
  const code = res.getResponseCode();
  let detail = "";
  try {
    const body = JSON.parse(res.getContentText());
    if (body && body.error && body.error.message) detail = body.error.message;
  } catch (e) {
    detail = String(res.getContentText() || "").slice(0, 300);
  }
  return "API 오류 " + code + (detail ? " — " + detail : "");
}

function buildPrompt_(row, published) {
  const pubBlock =
    published && published.length
      ? "\n[이미 게시된 기존 기사 목록] (제목 | 매체 | 날짜):\n" +
        published
          .slice(0, 60)
          .map((p) => "- " + p.title + " | " + (p.media || "") + " | " + (p.date || ""))
          .join("\n")
      : "";
  return [
    COMPANY_ABOUT,
    "아래 뉴스 후보가 이 회사 기사인지 판단하고 보강하라.",
    "",
    "제목: " + row.title,
    "언론사: " + row.media,
    "날짜: " + row.date,
    "현재 링크: " + row.url,
    pubBlock,
    "",
    "작업:",
    "1) 이 회사(" + COMPANY_NAMES + ") 기사인지 판단." +
      (NOT_US.length ? " " + NOT_US.join(", ") + "는 이름만 같은 다른 곳이므로 우리 회사가 아니다." : ""),
    '2) 현재 링크가 news.google.com 리다이렉트면 web_search로 "제목 언론사"를 검색해 실제 기사 원본 URL을 찾아라. 이미 실제 기사 URL이면 그대로 사용.',
    "3) 기사에서 우리 회사가 차지하는 비중을 보고 추천 액션을 정하라.",
    "   approve — 우리 회사·제품·대표가 기사의 주제인 경우. 단독 인터뷰, 우리 수상·투자·제품 소식 등 본문이 우리 이야기로 채워진 기사.",
    "   review  — 우리 회사가 등장하지만 기사의 주제는 따로 있는 경우. 선정 기업 목록, 행사 참가사 나열, 다른 기관의 프로그램·펀드 소개 중 한두 줄 언급 등. 게시할지는 사람이 판단하므로 reject 하지 말고 review 로 둔다.",
    "   reject  — 우리 회사 기사가 아니거나(동명이의) 이미 게시된 기사와 중복인 경우.",
    "4) review 로 판단했다면 reason 첫머리에 언급 수준을 적어라 (예: \"선정 기업 10곳 중 한 줄 언급\", \"행사 참가사로만 등장\"). 여러 매체가 같은 행사·보도자료를 함께 다룬 것으로 보이면 그 점도 덧붙여라.",
    "5) 정확한 언론사명을 한글로 판단하라 (예: 조선일보, 지디넷코리아, 머니투데이). 확실치 않으면 빈 문자열.",
    "6) 중복 판정은 좁게: 위 [기존 기사 목록]에 이 후보와 *동일한 기사*(같은 언론사가 쓴 바로 그 기사가 제목/URL만 다르게 수집된 경우)가 있으면 duplicate=true. 다른 언론사의 기사이거나 같은 사건을 다룬 별개 기사면 duplicate=false (중복 아님).",
    "",
    "아래 JSON 객체 하나만 출력하고 다른 텍스트는 절대 쓰지 마라:",
    '{"ours": true, "verdict": "approve|reject|review", "reason": "한두 문장 이유", "url": "실제 기사 URL 또는 빈 문자열", "media": "정확한 언론사명 또는 빈 문자열", "duplicate": false}',
  ].join("\n");
}

// ---- 사이트 반영 (재빌드) --------------------------------------------------

function triggerDeploy() {
  const ui = SpreadsheetApp.getUi();
  const hook = prop_("DEPLOY_HOOK_URL");
  if (!hook) {
    ui.alert("Script Properties에 DEPLOY_HOOK_URL을 먼저 넣어주세요.");
    return;
  }
  const res = UrlFetchApp.fetch(hook, { method: "post", muteHttpExceptions: true });
  const ok = res.getResponseCode() >= 200 && res.getResponseCode() < 300;
  const who = Session.getActiveUser().getEmail() || "담당자";
  notifySlack_(
    ok
      ? ":arrows_counterclockwise: *" +
          who +
          "* 님이 홈페이지 재배포를 시작했습니다. 승인된 뉴스가 1~2분 후 반영됩니다."
      : ":x: 재배포 요청이 실패했습니다."
  );
  ui.alert(
    ok
      ? "재빌드를 시작했습니다. 승인된 뉴스가 1~2분 후 사이트에 반영됩니다."
      : "재빌드 요청 실패 (" + res.getResponseCode() + "). URL을 확인하세요."
  );
}

// ---- helpers -------------------------------------------------------------

function firstSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

function headerIndex_(headerRow) {
  const col = {};
  headerRow.forEach((h, i) => (col[String(h).trim()] = i));
  return col;
}

// 1행에 COLUMNS 가 다 있는지 본다. 열 이름에 오타가 있으면(예: "ai verdict") 그 열은 col 에 없어
// setCell_ 이 조용히 건너뛴다 — ai_verdict 가 계속 비어 같은 행이 매 실행마다 다시 뽑힌다.
// 빠진 열이 있으면 그 이름을 담은 안내문을, 다 있으면 빈 문자열을 돌려준다.
function missingColumnsNote_(col) {
  const missing = COLUMNS.filter((name) => col[name] === undefined);
  return missing.length
    ? "시트 1행에 필수 열이 없습니다: " + missing.join(", ") + " (열 이름의 오타·띄어쓰기를 확인해주세요)"
    : "";
}

function countPending_(sheet) {
  const data = sheet.getDataRange().getValues();
  const col = headerIndex_(data[0]);
  let n = 0;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][col.status] || "").toLowerCase() === "pending") n++;
  }
  return n;
}

function prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function setCell_(sheet, rowNum, colIndex, value) {
  if (colIndex === undefined) return;
  sheet.getRange(rowNum, colIndex + 1).setValue(value);
}

// " 시트에서 확정해주세요: <시트 주소>" — empty string when nothing is pending.
function confirmCta_(pendingTotal) {
  if (!pendingTotal) return "";
  return " 시트에서 확정해주세요: " + SpreadsheetApp.getActiveSpreadsheet().getUrl();
}

function notifySlack_(text) {
  const hook = prop_("SLACK_WEBHOOK_URL");
  if (!hook || hook.indexOf("http") !== 0) return;
  UrlFetchApp.fetch(hook, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
}
