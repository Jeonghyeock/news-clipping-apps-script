// 홈페이지 빌드 전에 실행한다: 시트에서 status 가 approved 인 행만 읽어 JSON 파일로 저장한다.
//
// 시트를 '웹에 게시'해서 읽지 않는 이유: 그러면 검토 중인 후보와 AI 판단 이유까지 누구나 볼 수 있다.
// 대신 시트를 읽기 전용 서비스 계정에만 공유하고, 빌드할 때 그 계정으로 읽는다.
//
//   NEWS_SHEET_ID                시트 주소의 /d/ 와 /edit 사이 값
//   GOOGLE_SERVICE_ACCOUNT_JSON  서비스 계정 키 JSON 전체(한 줄 문자열)
//   NEWS_OUTPUT                  저장할 파일 (기본 news.json)
//   NEWS_FALLBACK_IMAGE          image 칸이 비었을 때 쓸 이미지 경로 (선택)
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JWT } from 'google-auth-library';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// 첫 번째 탭을 읽어 1행(열 이름)을 키로 하는 객체 목록으로 돌려준다.
// 열 순서는 시트가 정하므로 사람이 열을 옮겨도 된다(Apps Script 쪽도 열 이름으로 읽는다).
export async function readRows({ sheetId, credentials }) {
  const client = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const meta = await client.request({ url: `${SHEETS_API}/${sheetId}?fields=sheets.properties.title` });
  const tab = meta.data.sheets[0].properties.title; // 새 시트는 "시트1" 또는 "Sheet1"
  const range = `'${tab.replaceAll("'", "''")}'!A1:Z`;
  const res = await client.request({ url: `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(range)}` });
  return toObjects(res.data.values ?? []);
}

export function toObjects(values) {
  const [header, ...rows] = values;
  if (!header) return [];
  const keys = header.map((h) => String(h).trim());
  return rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i] ?? ''])));
}

// 사람이 approved 로 바꾼 행만 내보낸다. AI 판단(ai_verdict)은 참고용이라 여기서 보지 않는다.
export function toNewsItems(rows, { fallbackImage } = {}) {
  return rows
    .filter((r) => String(r.status ?? '').trim().toLowerCase() === 'approved')
    .map((r) => ({
      title: r.title,
      media: r.media,
      date: r.date,
      url: r.url,
      image: r.image || fallbackImage || undefined,
      description: r.description || undefined,
    }))
    .filter((item) => item.title && item.url)
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

async function main() {
  const output = process.env.NEWS_OUTPUT ?? 'news.json';
  let items = [];
  try {
    const sheetId = process.env.NEWS_SHEET_ID;
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!sheetId || !raw) throw new Error('NEWS_SHEET_ID 또는 GOOGLE_SERVICE_ACCOUNT_JSON 이 없습니다');
    const rows = await readRows({ sheetId, credentials: JSON.parse(raw) });
    items = toNewsItems(rows, { fallbackImage: process.env.NEWS_FALLBACK_IMAGE });
  } catch (error) {
    // 자격 증명이 없거나(로컬 개발) 시트를 못 읽어도 빌드는 깨지지 않게 빈 목록을 쓴다.
    // 사이트는 빈 목록이면 코드 안의 기본 목록을 보여 주도록 만들어 둔다.
    console.warn(`[news] 빈 목록을 씁니다 — ${error.message}`);
  }
  await writeFile(output, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  console.log(`[news] 승인된 기사 ${items.length}건 → ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
