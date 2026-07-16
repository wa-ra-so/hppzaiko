// data/*.json の整合性チェック＋簡易ロジックテスト。Actionsの台帳更新前後で実行し、
// 壊れたJSONやフォーマット崩れがあれば公開前に検知して止める（新店リサーチ側の
// test-filters.mjs と同じ「監査してから公開」方針）。
// 使い方: node scripts/test-data.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PREFECTURES } from './prefectures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

let failures = 0;

function fail(msg) {
  failures++;
  console.error(`[NG] ${msg}`);
}

function ok(msg) {
  console.log(`[ok] ${msg}`);
}

async function loadJson(file) {
  const raw = await readFile(path.join(DATA_DIR, file), 'utf-8');
  return JSON.parse(raw); // 壊れたJSONはここで例外→テスト全体を失敗させる
}

async function checkRoster(pref) {
  const file = pref.dataFile.replace(/^stores/, 'hotpepper-roster');
  const json = await loadJson(file);
  assert.equal(typeof json.updatedAt, 'string', `${file}: updatedAt must be a string`);
  assert.equal(json.pref, pref.id, `${file}: pref must be "${pref.id}"`);
  assert.equal(typeof json.shops, 'object', `${file}: shops must be an object`);
  assert.ok(json.shops && !Array.isArray(json.shops), `${file}: shops must not be an array`);
  const ids = Object.keys(json.shops);
  assert.ok(ids.length > 0, `${file}: shops must not be empty`);
  const sample = json.shops[ids[0]];
  for (const field of ['name', 'address', 'firstSeenAt', 'lastSeenAt']) {
    assert.ok(field in sample, `${file}: shop record missing "${field}"`);
  }
  // reservationLostAt が付いている店は lastSeenAt がなくても構わないが、
  // reservable=false になっているはず（可否チェック結果と矛盾していないか）
  for (const [id, s] of Object.entries(json.shops)) {
    if (s.reservationLostAt) {
      assert.equal(s.reservable, false, `${file}: shop ${id} has reservationLostAt but reservable !== false`);
    }
  }
  ok(`${file}: ${ids.length} 件の台帳を検証`);
  return json;
}

async function checkLost(pref, roster) {
  const file = pref.dataFile.replace(/^stores/, 'hotpepper-reservation-lost');
  const json = await loadJson(file);
  assert.equal(json.pref, pref.id, `${file}: pref must be "${pref.id}"`);
  assert.ok(Array.isArray(json.items), `${file}: items must be an array`);
  for (const it of json.items) {
    for (const field of ['id', 'name', 'reservationLostAt']) {
      assert.ok(field in it, `${file}: item missing "${field}"`);
    }
  }
  // 軽量抽出版は台帳の reservationLostAt 付き件数と一致していないといけない
  // （hotpepper-roster.mjs が同じ stamp で両方書き出すため）
  const rosterLostCount = Object.values(roster.shops).filter(s => !!s.reservationLostAt).length;
  assert.equal(json.items.length, rosterLostCount,
    `${file}: items.length (${json.items.length}) must match roster reservationLostAt count (${rosterLostCount})`);
  ok(`${file}: ${json.items.length} 件のアタックリストを検証（台帳と一致）`);
}

async function main() {
  for (const pref of Object.values(PREFECTURES)) {
    try {
      const roster = await checkRoster(pref);
      await checkLost(pref, roster);
    } catch (err) {
      fail(`${pref.id}: ${err.message}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} 件のチェックに失敗しました`);
    process.exit(1);
  }
  console.log('\nすべてのチェックに合格しました');
}

main();
