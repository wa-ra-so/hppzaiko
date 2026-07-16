// ①判定ロジック（applyReservableCheck）の単体テスト、②data/*.json の整合性チェックを行う。
// Actionsの台帳更新前後で実行し、壊れたJSON・フォーマット崩れ・判定ロジックの劣化が
// あれば公開前に検知して止める（sinntenn側の test-filters.mjs と同じ「監査してから公開」方針）。
// 使い方: node scripts/test-data.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PREFECTURES } from './prefectures.mjs';
import { applyReservableCheck, checkReservable, hasMinDelistedTenure } from './hotpepper-roster.mjs';

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

// ── ①判定ロジック単体テスト（2段階確認方式が壊れていないか） ──
function testApplyReservableCheck() {
  const T1 = '2026-07-01T00:00:00.000Z';
  const T2 = '2026-07-01T08:00:00.000Z';
  const T3 = '2026-07-01T16:00:00.000Z';

  // 初回チェックでfalse＝元々予約なし。疑い・確定どちらにもしない
  {
    const { shop, newlyConfirmedLost } = applyReservableCheck({}, false, T1);
    assert.equal(newlyConfirmedLost, false, '初回false: newlyConfirmedLostはfalse');
    assert.equal(shop.reservationSuspectedAt, undefined, '初回false: 疑いを立てない');
    assert.equal(shop.reservationLostAt, undefined, '初回false: 確定しない');
    assert.equal(shop.reservable, false);
  }

  // reservable:true → 1回目のfalse検出＝疑いのみ（まだ確定しない）
  {
    const prev = { reservable: true, reservableCheckedAt: T1, lastReservableAt: T1 };
    const { shop, newlyConfirmedLost } = applyReservableCheck(prev, false, T2);
    assert.equal(newlyConfirmedLost, false, '1回目検出: newlyConfirmedLostはfalse（即確定しない）');
    assert.equal(shop.reservationSuspectedAt, T2, '1回目検出: reservationSuspectedAtを記録');
    assert.equal(shop.reservationLostAt, undefined, '1回目検出: reservationLostAtはまだ立てない');
  }

  // 疑い中 → 2回目も連続してfalse＝確定（アタックリスト入り）
  {
    const prev = { reservable: false, reservableCheckedAt: T2, lastReservableAt: T1, reservationSuspectedAt: T2 };
    const { shop, newlyConfirmedLost } = applyReservableCheck(prev, false, T3);
    assert.equal(newlyConfirmedLost, true, '2回目検出: newlyConfirmedLostはtrue（確定）');
    assert.equal(shop.reservationLostAt, T3, '2回目検出: reservationLostAtを記録');
    assert.equal(shop.reservationSuspectedAt, T2, '2回目検出: reservationSuspectedAt（1回目の日）は保持');
  }

  // 疑い中に true が確認できた＝誤検出/回復。疑いを解除し確定させない
  {
    const prev = { reservable: false, reservableCheckedAt: T2, lastReservableAt: T1, reservationSuspectedAt: T2 };
    const { shop, newlyConfirmedLost } = applyReservableCheck(prev, true, T3);
    assert.equal(newlyConfirmedLost, false, '疑い解除: newlyConfirmedLostはfalse');
    assert.equal(shop.reservationSuspectedAt, undefined, '疑い解除: reservationSuspectedAtを削除');
    assert.equal(shop.reservable, true);
    assert.equal(shop.lastReservableAt, T3);
  }

  // 確定済み（アタックリスト掲載中）の店が true に戻った＝アタックリストから復帰
  {
    const prev = { reservable: false, reservableCheckedAt: T2, lastReservableAt: T1, reservationSuspectedAt: T1, reservationLostAt: T2 };
    const { shop, newlyConfirmedLost } = applyReservableCheck(prev, true, T3);
    assert.equal(newlyConfirmedLost, false);
    assert.equal(shop.reservationLostAt, undefined, '復帰: reservationLostAtを削除（アタックリストから外れる）');
    assert.equal(shop.reservationSuspectedAt, undefined, '復帰: reservationSuspectedAtも削除');
  }

  // 確定済みの店を再チェックして再びfalse＝確定状態を維持。日付は上書きしない
  {
    const prev = { reservable: false, reservableCheckedAt: T2, lastReservableAt: T1, reservationSuspectedAt: T1, reservationLostAt: T2 };
    const { shop, newlyConfirmedLost } = applyReservableCheck(prev, false, T3);
    assert.equal(newlyConfirmedLost, false, '確定済み再確認: newlyConfirmedLostはfalse（二重カウントしない）');
    assert.equal(shop.reservationLostAt, T2, '確定済み再確認: reservationLostAt（確定日）は上書きしない');
    assert.equal(shop.reservableCheckedAt, T3, '確定済み再確認: reservableCheckedAtだけ更新');
  }

  ok('applyReservableCheck: 2段階確認ロジックの単体テスト 7/7 パス');
}

// ── ①'checkReservable単体テスト（title/body二重チェックが壊れていないか） ──
async function testCheckReservable() {
  const realFetch = globalThis.fetch;
  const html = (title, body = '') => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const mockFetch = (map) => async () => ({ ok: true, text: async () => map });

  try {
    // タイトルに「ネット予約可」あり → true
    globalThis.fetch = mockFetch(html('○○店＜ネット予約可＞'));
    assert.equal(await checkReservable('https://example.test/'), true, 'title有: true');

    // タイトルに無いが本文に不可メッセージあり → false（裏取りできた）
    globalThis.fetch = mockFetch(html('○○店', '現在ネット予約を受け付けていません'));
    assert.equal(await checkReservable('https://example.test/'), false, 'title無+body裏取りあり: false');

    // タイトルに無く本文にも不可メッセージが無い（＝仕様変更やbot判定ページの疑い）→ null（誤検出防止）
    globalThis.fetch = mockFetch(html('○○店', '通常の店舗紹介文'));
    assert.equal(await checkReservable('https://example.test/'), null, 'title無+body裏取り無し: null（falseと決め打ちしない）');

    // <title>自体が無い（想定外のページ）→ null
    globalThis.fetch = mockFetch('<html><body>no title here</body></html>');
    assert.equal(await checkReservable('https://example.test/'), null, 'titleタグ無し: null');

    // HTTPエラー → null
    globalThis.fetch = async () => ({ ok: false });
    assert.equal(await checkReservable('https://example.test/'), null, 'HTTPエラー: null');

    // fetch自体が例外 → null
    globalThis.fetch = async () => { throw new Error('network error'); };
    assert.equal(await checkReservable('https://example.test/'), null, 'fetch例外: null');

    ok('checkReservable: title/body二重チェックの単体テスト 6/6 パス');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── ①''hasMinDelistedTenure単体テスト（新規掲載直後の店を解約と誤判定しないためのゲート） ──
function testHasMinDelistedTenure() {
  const hour = 60 * 60 * 1000;
  const base = Date.parse('2026-07-01T00:00:00.000Z');
  const iso = (offsetHours) => new Date(base + offsetHours * hour).toISOString();

  // 観測期間が48時間ちょうど未満 → false（新規掲載直後の変動を解約扱いしない）
  assert.equal(
    hasMinDelistedTenure({ firstSeenAt: iso(0), lastSeenAt: iso(24) }),
    false, '観測24時間: 満たさない');
  assert.equal(
    hasMinDelistedTenure({ firstSeenAt: iso(0), lastSeenAt: iso(47.9) }),
    false, '観測47.9時間: 満たさない（境界未満）');

  // 48時間以上 → true
  assert.equal(
    hasMinDelistedTenure({ firstSeenAt: iso(0), lastSeenAt: iso(48) }),
    true, '観測48時間ちょうど: 満たす（境界）');
  assert.equal(
    hasMinDelistedTenure({ firstSeenAt: iso(0), lastSeenAt: iso(240) }),
    true, '観測10日: 満たす');

  // 日付が欠けている（壊れたデータ）→ false側に倒れる（誤って解約確定しない）
  assert.equal(hasMinDelistedTenure({ lastSeenAt: iso(240) }), false, 'firstSeenAt欠落: false側');
  assert.equal(hasMinDelistedTenure({ firstSeenAt: iso(0) }), false, 'lastSeenAt欠落: false側');

  ok('hasMinDelistedTenure: 単体テスト 6/6 パス');
}

// ── ②data/*.json の整合性チェック ──
async function loadExcludedIds() {
  try {
    const json = await loadJson('manual-overrides.json');
    assert.ok(Array.isArray(json.excludedIds), 'manual-overrides.json: excludedIds must be an array');
    return new Set(json.excludedIds);
  } catch (err) {
    fail(`manual-overrides.json: ${err.message}`);
    return new Set();
  }
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
  for (const [id, s] of Object.entries(json.shops)) {
    if (s.reservationLostAt) {
      // reservationLostAt が付いている店は reservable=false になっているはず
      assert.equal(s.reservable, false, `${file}: shop ${id} has reservationLostAt but reservable !== false`);
      // 確定（2回目）の前提として1回目の検出日も残っているはず
      assert.ok(s.reservationSuspectedAt, `${file}: shop ${id} has reservationLostAt but no reservationSuspectedAt (1回目の記録)`);
    }
    if (s.delistedAt) {
      // 解約と確定している店は最低観測期間（48時間）を満たしているはず
      // （新規掲載直後の変動を解約と誤判定していないか）
      assert.ok(hasMinDelistedTenure(s), `${file}: shop ${id} has delistedAt but does not meet the minimum tenure`);
    }
  }
  ok(`${file}: ${ids.length} 件の台帳を検証`);
  return json;
}

async function checkLost(pref, roster, excludedIds) {
  const file = pref.dataFile.replace(/^stores/, 'hotpepper-reservation-lost');
  const json = await loadJson(file);
  assert.equal(json.pref, pref.id, `${file}: pref must be "${pref.id}"`);
  assert.ok(Array.isArray(json.items), `${file}: items must be an array`);
  for (const it of json.items) {
    for (const field of ['id', 'name', 'reservationLostAt']) {
      assert.ok(field in it, `${file}: item missing "${field}"`);
    }
    assert.ok(!excludedIds.has(it.id), `${file}: item ${it.id} is in manual-overrides excludedIds but still published`);
  }
  // 軽量抽出版は「台帳の reservationLostAt 付き件数」から「手動除外件数」を引いたものと一致するはず
  // （hotpepper-roster.mjs が同じ stamp で両方書き出すため）
  const rosterLostIds = Object.entries(roster.shops).filter(([, s]) => !!s.reservationLostAt).map(([id]) => id);
  const expectedCount = rosterLostIds.filter(id => !excludedIds.has(id)).length;
  assert.equal(json.items.length, expectedCount,
    `${file}: items.length (${json.items.length}) must match roster reservationLostAt count minus manual overrides (${expectedCount})`);
  ok(`${file}: ${json.items.length} 件のアタックリストを検証（台帳と一致）`);
}

async function checkDelisted(pref, roster, excludedIds) {
  const file = pref.dataFile.replace(/^stores/, 'hotpepper-delisted');
  const json = await loadJson(file);
  assert.equal(json.pref, pref.id, `${file}: pref must be "${pref.id}"`);
  assert.ok(Array.isArray(json.items), `${file}: items must be an array`);
  for (const it of json.items) {
    for (const field of ['id', 'name', 'delistedAt', 'lastSeenAt']) {
      assert.ok(field in it, `${file}: item missing "${field}"`);
    }
    assert.ok(!excludedIds.has(it.id), `${file}: item ${it.id} is in manual-overrides excludedIds but still published`);
    assert.ok(hasMinDelistedTenure(it), `${file}: item ${it.id} does not meet the minimum tenure`);
  }
  // 軽量抽出版は「台帳の delistedAt 付き件数」から「手動除外件数」を引いたものと一致するはず
  const rosterDelistedIds = Object.entries(roster.shops).filter(([, s]) => !!s.delistedAt).map(([id]) => id);
  const expectedCount = rosterDelistedIds.filter(id => !excludedIds.has(id)).length;
  assert.equal(json.items.length, expectedCount,
    `${file}: items.length (${json.items.length}) must match roster delistedAt count minus manual overrides (${expectedCount})`);
  ok(`${file}: ${json.items.length} 件の解約リストを検証（台帳と一致）`);
}

async function main() {
  testApplyReservableCheck();
  await testCheckReservable();
  testHasMinDelistedTenure();

  const excludedIds = await loadExcludedIds();
  for (const pref of Object.values(PREFECTURES)) {
    try {
      const roster = await checkRoster(pref);
      await checkLost(pref, roster, excludedIds);
      await checkDelisted(pref, roster, excludedIds);
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
