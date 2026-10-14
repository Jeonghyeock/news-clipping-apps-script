import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Code.gs 는 Apps Script 전용 파일이라 import 할 수 없다. 대신 Node 의 vm 안에서 그대로 실행하고,
// Apps Script 전역 객체(UrlFetchApp, PropertiesService 등)는 테스트가 가짜로 넣어 준다.
// 함수 선언은 context 의 속성이 되므로, 테스트에서 함수를 바꿔 끼울 수도 있다(fetchGoogleNews_ 등).
const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

export function loadScript({ properties = {}, responses = [] } = {}) {
  const requests = [];
  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (name) => properties[name] ?? null }),
    },
    // fetch 할 때마다 responses 에서 하나씩 꺼내 준다. 보낸 요청은 requests 에 남긴다.
    UrlFetchApp: {
      fetch(url, options = {}) {
        requests.push({ url, options, payload: options.payload ? JSON.parse(options.payload) : undefined });
        const next = responses.shift();
        if (!next) throw new Error(`unexpected fetch: ${url}`);
        return {
          getResponseCode: () => next.status ?? 200,
          getContentText: () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
        };
      },
    },
  });
  vm.runInContext(source, context);
  return { gs: context, requests };
}

// getDataRange / getRange / sort 만 흉내 내는 가짜 시트. rows[0] 이 열 이름 행이다.
export class FakeSheet {
  constructor(rows) {
    this.rows = rows.map((r) => [...r]);
    this.sorted = false;
  }
  getDataRange() {
    return { getValues: () => this.rows.map((r) => [...r]) };
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return this.rows[0].length;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
      setValues(values) {
        values.forEach((v, i) => {
          sheet.rows[row - 1 + i] = sheet.rows[row - 1 + i] ?? new Array(sheet.getLastColumn()).fill('');
          v.forEach((cell, j) => (sheet.rows[row - 1 + i][col - 1 + j] = cell));
        });
      },
      setValue(value) {
        sheet.rows[row - 1][col - 1] = value;
      },
      sort({ column, ascending }) {
        const body = sheet.rows.slice(row - 1, row - 1 + numRows);
        body.sort((a, b) => String(a[column - 1]).localeCompare(String(b[column - 1])) * (ascending ? 1 : -1));
        sheet.rows.splice(row - 1, numRows, ...body);
        sheet.sorted = true;
      },
    };
  }
}

export const HEADER = ['status', 'title', 'media', 'date', 'url', 'image', 'description', 'ai_verdict', 'ai_reason'];

export function row(values) {
  return HEADER.map((key) => values[key] ?? '');
}
