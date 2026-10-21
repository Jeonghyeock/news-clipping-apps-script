import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FakeSheet, HEADER, loadScript, row } from './load-script.mjs';

const KEY = 'sk-ant-test';
const answer = (obj, extra = {}) => ({
  body: { content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', ...extra },
});
const article = { title: '샘플테크 투자 유치', media: '조선비즈', date: '2025.03.02', url: 'https://news.google.com/x' };

describe('후보 정리 도우미', () => {
  const { gs } = loadScript();

  test('추적 파라미터만 지우고, 기사를 가리키는 파라미터와 #은 남긴다', () => {
    assert.equal(gs.cleanUrl_('https://a.com/n?idxno=1&utm_source=naver&lfrom=kakao#top'), 'https://a.com/n?idxno=1#top');
    assert.equal(gs.cleanUrl_('https://a.com/n?utm_source=x'), 'https://a.com/n');
    assert.equal(gs.cleanUrl_('https://a.com/n'), 'https://a.com/n');
  });

  test('제목을 비교할 때 대소문자·기호·전각 문자·공백 차이를 무시한다', () => {
    assert.equal(gs.normTitle_('［단독］ SampleTech,  투자 유치!'), gs.normTitle_('단독 sampletech 투자 유치'));
  });

  test('발행 시각을 한국 날짜로 바꾼다 (UTC 15시가 KST 자정)', () => {
    assert.equal(gs.toDateKST_('Mon, 01 Sep 2025 15:30:00 GMT'), '2025.09.02');
    assert.equal(gs.toDateKST_('Mon, 01 Sep 2025 14:59:00 GMT'), '2025.09.01');
    assert.equal(gs.toDateKST_(''), '');
    assert.equal(gs.toDateKST_('날짜 아님'), '');
  });

  test('제목에 회사 이름이 없으면 본문 조각으로 판정하고, 이름만 같은 회사는 버린다', () => {
    assert.equal(gs.isRelevant_('샘플테크, 시리즈A 유치', ''), true);
    assert.equal(gs.isRelevant_('물류 로봇 스타트업 인터뷰', '샘플원을 만든 대표는'), true);
    assert.equal(gs.isRelevant_('물류 로봇 스타트업 인터뷰', ''), false);
    assert.equal(gs.isRelevant_('샘플테크자산운용, 새 펀드 출시', ''), false);
    assert.equal(gs.isRelevant_('부동산 펀드 출시', '샘플테크 자산운용이 운용하는'), false);
  });

  test('설립일 이전 기사는 버리고, 날짜를 못 읽은 기사는 사람이 보도록 남긴다', () => {
    assert.equal(gs.isRecentEnough_('2022.12.31'), false);
    assert.equal(gs.isRecentEnough_('2023.01.01'), true);
    assert.equal(gs.isRecentEnough_(''), true);
  });

  test('구글 뉴스 제목 끝의 " - 언론사"를 떼고, 네이버 링크는 호스트로 언론사를 정한다', () => {
    assert.equal(gs.cleanTitle_('샘플테크 투자 유치 - 조선비즈', '조선비즈'), '샘플테크 투자 유치');
    assert.equal(gs.mediaFromUrl_('https://www.hankyung.com/article/1'), '한국경제');
    assert.equal(gs.mediaFromUrl_('https://news.example.kr/a'), 'news.example.kr');
  });
});

describe('crawlCore_', () => {
  test('중복·설립 이전·무관한 기사를 빼고 새 후보만 pending 으로 추가한 뒤 날짜순으로 정렬한다', () => {
    const { gs } = loadScript();
    const sheet = new FakeSheet([
      HEADER,
      row({ status: 'approved', title: '샘플테크, 시리즈A 100억 유치', media: '한국경제', date: '2025.03.02', url: 'https://www.hankyung.com/a/1?utm_source=naver' }),
    ]);
    // 키워드가 3개라 아래 목록이 세 번씩 돌아온다 — 같은 실행 안의 중복도 걸러져야 한다.
    gs.fetchGoogleNews_ = () => [
      { title: '샘플테크 시리즈A 100억 유치!', url: 'https://news.google.com/x1', media: '조선비즈', date: '2025.03.02', snippet: '' }, // 기호만 다른 같은 제목
      { title: '샘플원 신제품 공개', url: 'https://news.google.com/x2', media: '전자신문', date: '2025.04.10', snippet: '' }, // 새 후보
    ];
    gs.fetchNaverNews_ = () => [
      { title: '로봇 업계 동향', url: 'https://www.hankyung.com/a/1', media: '한국경제', date: '2025.03.02', snippet: '샘플테크가 이끄는' }, // 추적 파라미터만 다른 같은 URL
      { title: '샘플테크 창업 이야기', url: 'https://old.example.com/1', media: 'old', date: '2022.05.01', snippet: '' }, // 설립 이전
      { title: '물류 시장 전망', url: 'https://x.example.com/1', media: 'x', date: '2025.05.01', snippet: '' }, // 무관
    ];

    assert.equal(gs.crawlCore_(sheet), 1);
    assert.equal(sheet.rows.length, 3);
    assert.ok(sheet.sorted);
    const [, newest] = sheet.rows;
    assert.deepEqual(newest.slice(0, 5), ['pending', '샘플원 신제품 공개', '전자신문', '2025.04.10', 'https://news.google.com/x2']);
  });

  test('새 행의 날짜 칸은 시트가 날짜 값으로 바꾸지 않게 일반 텍스트(@)로 둔다', () => {
    const { gs } = loadScript();
    const sheet = new FakeSheet([
      HEADER,
      row({ status: 'approved', title: '샘플원 예전 기사', media: '매일경제', date: '2025.01.01', url: 'https://n.example/0' }),
    ]);
    gs.fetchGoogleNews_ = () => [
      { title: '샘플원 출시', url: 'https://n.example/1', media: '매일경제', date: '2025.06.01', snippet: '' },
      { title: '샘플테크 채용', url: 'https://n.example/2', media: '전자신문', date: '2025.06.02', snippet: '' },
    ];
    gs.fetchNaverNews_ = () => [];
    assert.equal(gs.crawlCore_(sheet), 2);
    // 새로 붙는 3행부터 2줄의 date 열(4번째 열)만 — 이미 있던 행과 다른 열은 건드리지 않는다.
    assert.deepEqual(sheet.numberFormats, [{ row: 3, col: 4, numRows: 2, numCols: 1, format: '@' }]);
  });

  test('사람이 열 순서를 바꿔도 열 이름을 보고 제자리에 쓴다', () => {
    const { gs } = loadScript();
    const header = ['url', 'date', 'title', 'status', 'media', 'ai_verdict', 'ai_reason', 'memo', 'image', 'description'];
    const sheet = new FakeSheet([header]);
    gs.fetchGoogleNews_ = () => [{ title: '샘플원 출시', url: 'https://n.example/1', media: '매일경제', date: '2025.06.01', snippet: '' }];
    gs.fetchNaverNews_ = () => [];
    gs.crawlCore_(sheet);
    assert.deepEqual(sheet.rows[1], ['https://n.example/1', '2025.06.01', '샘플원 출시', 'pending', '매일경제', '', '', '', '', '']);
  });

  test('1행 열 이름에 오타가 있으면 검색하기 전에 빠진 열 이름을 알리며 멈춘다 (메뉴 실행이면 창으로)', () => {
    const { gs } = loadScript();
    const header = HEADER.map((h) => (h === 'url' ? 'URL ' : h));
    const sheet = new FakeSheet([header]);
    let searched = 0;
    gs.fetchGoogleNews_ = () => (searched++, []);
    gs.fetchNaverNews_ = () => (searched++, []);
    assert.throws(() => gs.crawlCore_(sheet), /필수 열이 없습니다: url/);

    const alerts = [];
    gs.SpreadsheetApp = {
      getUi: () => ({ alert: (message) => alerts.push(message) }),
      getActiveSpreadsheet: () => ({ getSheets: () => [sheet] }),
    };
    gs.crawlNews();
    assert.match(alerts[0], /^크롤을 중단했습니다\.\n\n시트 1행에 필수 열이 없습니다: url/);
    assert.equal(searched, 0);
    assert.equal(sheet.rows.length, 1);
  });
});

describe('verifyOne_', () => {
  test('웹 검색이 pause_turn 으로 끊기면 받은 턴을 그대로 붙여 이어서 보낸다 ("계속" 같은 말은 덧붙이지 않는다)', () => {
    const paused = {
      content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: '샘플테크 조선비즈' } }],
      stop_reason: 'pause_turn',
    };
    const { gs, requests } = loadScript({
      responses: [
        { body: paused },
        answer({ ours: true, verdict: 'approve', reason: '단독 인터뷰', url: 'https://biz.chosun.com/1', media: '조선비즈', duplicate: false }),
      ],
    });
    const result = gs.verifyOne_(KEY, article, []);

    assert.equal(requests.length, 2);
    const resent = requests[1].payload.messages;
    assert.equal(resent.length, 2);
    assert.equal(resent[1].role, 'assistant');
    assert.deepEqual(resent[1].content, paused.content);
    assert.equal(result.verdict, 'approve');
    assert.equal(result.url, 'https://biz.chosun.com/1');

    const first = requests[0];
    assert.equal(first.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(first.options.headers['x-api-key'], KEY);
    assert.deepEqual(first.payload.tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  });

  test('출력이 max_tokens 에서 잘리면 설정 문제로 알리고 재시도 대상으로 두지 않는다', () => {
    const { gs } = loadScript({ responses: [{ body: { content: [{ type: 'text', text: '{"ours": tr' }], stop_reason: 'max_tokens' } }] });
    const result = gs.verifyOne_(KEY, article, []);
    assert.match(result.error, /max_tokens/);
    assert.equal(result.retryable, false);
  });

  test('429·5xx 는 잠시 뒤 다시 할 오류, 400 은 남은 행에서도 똑같이 실패할 오류로 구분한다', () => {
    const { gs } = loadScript({
      responses: [
        { status: 429, body: { error: { message: 'rate limited' } } },
        { status: 529, body: { error: { message: 'overloaded' } } },
        { status: 400, body: { error: { message: 'model: not found' } } },
      ],
    });
    assert.equal(gs.verifyOne_(KEY, article, []).retryable, true);
    assert.equal(gs.verifyOne_(KEY, article, []).retryable, true);
    const bad = gs.verifyOne_(KEY, article, []);
    assert.equal(bad.retryable, false);
    assert.match(bad.error, /400 — model: not found/);
  });

  test('DNS 실패·시간 초과처럼 fetch 가 예외를 던지면 밖으로 내보내지 않고 다시 할 오류로 돌려준다', () => {
    const { gs } = loadScript({ responses: [{ throws: 'Address unavailable: https://api.anthropic.com/v1/messages' }] });
    const result = gs.verifyOne_(KEY, article, []);
    assert.equal(result.retryable, true);
    assert.match(result.error, /네트워크 오류·시간 초과\) — Address unavailable/);
  });

  test('모델이 판단을 거절하면 사람이 보도록 review 로 남긴다', () => {
    const { gs } = loadScript({ responses: [{ body: { content: [], stop_reason: 'refusal' } }] });
    const result = gs.verifyOne_(KEY, article, []);
    assert.equal(result.verdict, 'review');
    assert.equal(result.unparsed, undefined);
  });

  test('JSON 앞뒤에 다른 말이 붙어도 읽고, 모르는 verdict 는 review 로, JSON 이 없으면 unparsed 로 돌려준다', () => {
    const { gs } = loadScript({
      responses: [
        { body: { content: [{ type: 'text', text: '판단: {"verdict": "maybe", "reason": "애매함"} 이상입니다' }], stop_reason: 'end_turn' } },
        { body: { content: [{ type: 'text', text: '찾지 못했습니다' }], stop_reason: 'end_turn' } },
      ],
    });
    const loose = gs.verifyOne_(KEY, article, []);
    assert.equal(loose.verdict, 'review');
    assert.equal(loose.ours, true);
    assert.equal(gs.verifyOne_(KEY, article, []).unparsed, true);
  });
});

describe('verifyCore_', () => {
  const pending = (title, extra = {}) =>
    row({ status: 'pending', title, media: '언론사', date: '2025.03.02', url: `https://news.google.com/${title}`, ...extra });

  test('실패한 행은 비워 두고, 우리 회사가 아니거나 중복이면 reject 로 바꾸며, status 칸은 건드리지 않는다', () => {
    const sheet = new FakeSheet([
      HEADER,
      pending('A'),
      pending('B'),
      pending('C'),
      pending('D', { ai_verdict: 'approve' }), // 이미 검증한 행은 다시 쓰지 않는다
      row({ status: 'approved', title: '게시된 기사', media: '한국경제', date: '2024.12.01' }),
    ]);
    const { gs, requests } = loadScript({
      properties: { ANTHROPIC_API_KEY: KEY },
      responses: [
        answer({ ours: false, verdict: 'approve', reason: '샘플테크자산운용 기사', url: 'https://real.example/a?utm_source=x', media: '머니투데이' }),
        { status: 429, body: { error: { message: 'rate limited' } } },
        answer({ ours: true, verdict: 'approve', reason: '같은 기사', duplicate: true }),
      ],
    });
    const counts = gs.verifyCore_(sheet);

    assert.equal(requests.length, 3);
    assert.deepEqual(
      { done: counts.done, reject: counts.reject, deferred: counts.deferred, remaining: counts.remaining },
      { done: 2, reject: 2, deferred: 1, remaining: 1 },
    );
    const [, a, b, c, d] = sheet.rows;
    assert.equal(a[7], 'reject');
    assert.match(a[8], /^우리 회사 기사가 아님/);
    assert.equal(a[4], 'https://real.example/a'); // 모델이 찾아 준 원문 URL 도 추적 파라미터를 지운다
    assert.equal(a[2], '머니투데이');
    assert.equal(b[7], ''); // 다음 실행에서 다시 검증하도록 비워 둔다
    assert.equal(c[7], 'reject');
    assert.match(c[8], /^기존 게시 기사와 중복/);
    assert.equal(d[7], 'approve');
    for (const r of [a, b, c, d]) assert.equal(r[0], 'pending'); // 게시 여부는 사람이 정한다

    const prompt = requests[0].payload.messages[0].content;
    assert.match(prompt, /게시된 기사 \| 한국경제 \| 2024\.12\.01/);
    assert.match(prompt, /샘플테크\(SampleTech\)는 물류 로봇을/);
    assert.match(prompt, /"샘플테크자산운용"\(자산운용사\)는 이름만 같은 다른 곳/);
  });

  test('400 같은 요청 오류가 나면 남은 행을 부르지 않고 바로 멈춘다', () => {
    const sheet = new FakeSheet([HEADER, pending('A'), pending('B')]);
    const { gs, requests } = loadScript({
      properties: { ANTHROPIC_API_KEY: KEY },
      responses: [{ status: 400, body: { error: { message: 'credit balance is too low' } } }],
    });
    const counts = gs.verifyCore_(sheet);
    assert.equal(requests.length, 1);
    assert.match(counts.error, /credit balance/);
  });

  test('네트워크 오류가 난 행만 비워 두고 다음 행을 계속 검증한다', () => {
    const sheet = new FakeSheet([HEADER, pending('A'), pending('B')]);
    const { gs, requests } = loadScript({
      properties: { ANTHROPIC_API_KEY: KEY },
      responses: [{ throws: 'Timeout: https://api.anthropic.com/v1/messages' }, answer({ ours: true, verdict: 'approve', reason: '우리 기사' })],
    });
    const counts = gs.verifyCore_(sheet);
    assert.equal(requests.length, 2);
    assert.deepEqual({ done: counts.done, deferred: counts.deferred, remaining: counts.remaining }, { done: 1, deferred: 1, remaining: 1 });
    assert.match(counts.deferredNote, /Timeout/);
    const [, a, b] = sheet.rows;
    assert.equal(a[7], ''); // 다음 실행에서 다시 검증한다
    assert.equal(b[7], 'approve');
  });

  test('매일 자동 실행은 네트워크 오류가 나도 끝까지 돌아 Slack 요약을 보낸다', () => {
    const sheet = new FakeSheet([HEADER, pending('A')]);
    const { gs } = loadScript({
      properties: { ANTHROPIC_API_KEY: KEY },
      responses: [{ throws: 'Address unavailable: https://api.anthropic.com/v1/messages' }],
    });
    gs.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheets: () => [sheet], getUrl: () => 'https://sheet.example' }) };
    gs.fetchGoogleNews_ = () => [];
    gs.fetchNaverNews_ = () => [];
    const slack = [];
    gs.notifySlack_ = (text) => slack.push(text);

    gs.dailyRun();
    assert.equal(slack.length, 1);
    assert.match(slack[0], /일시적 오류로 건너뛴 1건은 다음 실행 때 재시도합니다/);
    assert.match(slack[0], /AI 검증 0건/);
    assert.equal(sheet.rows[1][7], '');
  });

  test('실행이 4분 30초를 넘으면 새 행을 시작하지 않고 남은 건수를 돌려준다 (6건 제한은 그대로)', () => {
    let clock = 1_000_000;
    const sheet = new FakeSheet([HEADER, ...'ABCDEF'.split('').map((t) => pending(t))]);
    const { gs, requests } = loadScript({
      properties: { ANTHROPIC_API_KEY: KEY },
      responses: Array.from({ length: 6 }, () => answer({ ours: true, verdict: 'approve', reason: '우리 기사' })),
      now: () => clock,
    });
    const fetch = gs.UrlFetchApp.fetch;
    gs.UrlFetchApp.fetch = (...args) => {
      clock += 100 * 1000; // 한 행에 100초 — 0·100·200초에 시작한 3건 뒤 300초에서 멈춘다
      return fetch(...args);
    };
    const counts = gs.verifyCore_(sheet);
    assert.equal(requests.length, 3);
    assert.deepEqual({ done: counts.done, remaining: counts.remaining, timedOut: counts.timedOut }, { done: 3, remaining: 3, timedOut: true });
    assert.deepEqual(sheet.rows.slice(1).map((r) => r[7]), ['approve', 'approve', 'approve', '', '', '']);

    // 매일 실행처럼 앞에서 이미 시간을 썼으면(크롤) 그 시간도 센다.
    const late = gs.verifyCore_(new FakeSheet([HEADER, pending('G')]), clock - 5 * 60 * 1000);
    assert.equal(requests.length, 3);
    assert.deepEqual({ remaining: late.remaining, timedOut: late.timedOut }, { remaining: 1, timedOut: true });
  });

  test('Apps Script 실행 시간 제한 때문에 한 번에 6건까지만 검증한다', () => {
    const sheet = new FakeSheet([HEADER, ...'ABCDEFGH'.split('').map((t) => pending(t))]);
    const { gs, requests } = loadScript({
      properties: { ANTHROPIC_API_KEY: KEY },
      responses: Array.from({ length: 6 }, () => answer({ ours: true, verdict: 'approve', reason: '우리 기사' })),
    });
    const counts = gs.verifyCore_(sheet);
    assert.equal(requests.length, 6);
    assert.equal(counts.remaining, 2);
  });

  test('1행 열 이름에 오타가 있으면 API 를 부르지 않고 빠진 열 이름을 오류로 돌려준다', () => {
    // ai_verdict 가 없으면 결과를 못 써서 같은 행을 매 실행마다 다시 검증(과금)하게 된다.
    const header = HEADER.map((h) => (h === 'ai_verdict' ? 'ai verdict' : h));
    const sheet = new FakeSheet([header, pending('A')]);
    const { gs, requests } = loadScript({
      properties: { ANTHROPIC_API_KEY: KEY },
      responses: [answer({ ours: true, verdict: 'approve', reason: '우리 기사' })],
    });
    const counts = gs.verifyCore_(sheet);
    assert.equal(requests.length, 0);
    assert.match(counts.error, /필수 열이 없습니다: ai_verdict/);
    assert.equal(counts.done, 0);
    assert.deepEqual(sheet.rows[1], pending('A'));
  });

  test('API 키가 없으면 아무 요청도 보내지 않는다', () => {
    const sheet = new FakeSheet([HEADER, pending('A')]);
    const { gs, requests } = loadScript();
    assert.equal(gs.verifyCore_(sheet).done, 0);
    assert.equal(requests.length, 0);
  });
});
