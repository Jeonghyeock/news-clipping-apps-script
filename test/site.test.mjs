import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { toNewsItems, toObjects } from '../site/fetch-approved-news.mjs';

describe('fetch-approved-news', () => {
  test('1행을 열 이름으로 써서 행을 객체로 바꾸고, 빈 칸은 빈 문자열로 채운다', () => {
    const rows = toObjects([
      [' status', 'title ', 'url'],
      ['approved', '기사 1'],
    ]);
    assert.deepEqual(rows, [{ status: 'approved', title: '기사 1', url: '' }]);
    assert.deepEqual(toObjects([]), []);
  });

  test('사람이 approved 로 바꾼 행만, 최신순으로 내보낸다', () => {
    const items = toNewsItems(
      [
        { status: 'approved', title: '옛 기사', url: 'https://a/1', date: '2024.01.05', image: '' },
        { status: 'pending', title: '검토 중', url: 'https://a/2', date: '2025.09.01', ai_verdict: 'approve' },
        { status: ' Approved ', title: '새 기사', url: 'https://a/3', date: '2025.03.02', image: 'https://img/3', description: '요약' },
        { status: 'approved', title: '링크 없음', url: '', date: '2025.05.01' },
        { status: 'rejected', title: '거절', url: 'https://a/4', date: '2025.06.01' },
      ],
      { fallbackImage: '/logo.png' },
    );
    assert.deepEqual(
      items.map((i) => i.title),
      ['새 기사', '옛 기사'],
    );
    assert.equal(items[0].image, 'https://img/3');
    assert.equal(items[1].image, '/logo.png');
    assert.equal(items[1].description, undefined);
  });

  test('자격 증명이 없으면 빌드를 깨지 않고 빈 목록을 쓴다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'news-'));
    try {
      const output = path.join(dir, 'news.json');
      const script = fileURLToPath(new URL('../site/fetch-approved-news.mjs', import.meta.url));
      const env = { ...process.env, NEWS_OUTPUT: output };
      delete env.NEWS_SHEET_ID;
      delete env.GOOGLE_SERVICE_ACCOUNT_JSON;
      execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
      assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
