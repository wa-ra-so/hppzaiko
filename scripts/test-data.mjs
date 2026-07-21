// ①判定ロジック（applyReservableCheck）の単体テスト、②data/*.json の整合性チェックを行う。
// Actionsの台帳更新前後で実行し、壊れたJSON・フォーマット崩れ・判定ロジックの劣化が
// あれば公開前に検知して止める（sinntenn側の test-filters.mjs と同じ「監査してから公開」方針）。
// 使い方: node scripts/test-data.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PREFECTURES } from './prefectures.mjs';
import { applyReservableCheck, checkReservable, extractPhone, hasMinDelistedTenure, isBootstrapRun, shouldClearSyntheticLostFlags, buildSlackMessage } from './hotpepper-roster.mjs';
import { normalizeAddress, groupByAddress } from './address-dedup.mjs';

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
    assert.equal((await checkReservable('https://example.test/')).reservable, true, 'title有: true');

    // タイトルに無いが本文に不可メッセージあり → false（裏取りできた）
    globalThis.fetch = mockFetch(html('○○店', '現在ネット予約を受け付けていません'));
    assert.equal((await checkReservable('https://example.test/')).reservable, false, 'title無+body裏取りあり: false');

    // タイトルに無く本文にも不可メッセージが無い（＝仕様変更やbot判定ページの疑い）→ null（誤検出防止）
    globalThis.fetch = mockFetch(html('○○店', '通常の店舗紹介文'));
    assert.equal((await checkReservable('https://example.test/')).reservable, null, 'title無+body裏取り無し: null（falseと決め打ちしない）');

    // <title>自体が無い（想定外のページ）→ null
    globalThis.fetch = mockFetch('<html><body>no title here</body></html>');
    assert.equal((await checkReservable('https://example.test/')).reservable, null, 'titleタグ無し: null');

    // HTTPエラー → null
    globalThis.fetch = async () => ({ ok: false });
    assert.equal((await checkReservable('https://example.test/')).reservable, null, 'HTTPエラー: null');

    // fetch自体が例外 → null
    globalThis.fetch = async () => { throw new Error('network error'); };
    assert.equal((await checkReservable('https://example.test/')).reservable, null, 'fetch例外: null');

    // tel: リンクがあれば reservable の判定結果とは独立して電話番号も返す
    globalThis.fetch = mockFetch(html('○○店＜ネット予約可＞', '<a href="tel:0312345678">電話する</a>'));
    assert.equal((await checkReservable('https://example.test/')).tel, '0312345678', 'tel:リンクあり: 電話番号を抽出');

    // ページ取得自体に失敗した場合はtelもnull
    globalThis.fetch = async () => ({ ok: false });
    assert.equal((await checkReservable('https://example.test/')).tel, null, 'HTTPエラー時: telもnull');

    ok('checkReservable: title/body二重チェック・電話番号抽出の単体テスト 8/8 パス');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── ①''extractPhone単体テスト（tel:リンク／JSON-LDからの電話番号抽出） ──
function testExtractPhone() {
  assert.equal(
    extractPhone('<a href="tel:0312345678">電話する</a>'),
    '0312345678',
    'tel:リンク（数字のみ）から抽出',
  );
  assert.equal(
    extractPhone('<a href="tel:03-1234-5678">電話する</a>'),
    '03-1234-5678',
    'tel:リンク（ハイフン付き）から抽出',
  );
  assert.equal(
    extractPhone('<script type="application/ld+json">{"telephone":"03-1234-5678"}</script>'),
    '03-1234-5678',
    'tel:リンクが無くJSON-LDのtelephoneがあれば代わりに抽出',
  );
  assert.equal(
    extractPhone('<p>電話でのお問い合わせはこちら</p>'),
    null,
    'どちらのパターンも無ければnull',
  );
  ok('extractPhone: 電話番号抽出の単体テスト 4/4 パス');
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

// ── ①'''isBootstrapRun単体テスト（初回起動時の一括登録を新規掲載として誤検出しないためのゲート） ──
function testIsBootstrapRun() {
  assert.equal(isBootstrapRun(''), true, '台帳が空文字（初回起動）: true');
  assert.equal(isBootstrapRun(undefined), true, '台帳がundefined: true');
  assert.equal(isBootstrapRun('2026-07-14T21:49:45.409Z'), false, '台帳に既存のupdatedAtあり: false');
  ok('isBootstrapRun: 単体テスト 3/3 パス');
}

// ── ①''''shouldClearSyntheticLostFlags単体テスト（再掲載時に解約起因の合成フラグだけを消す） ──
function testShouldClearSyntheticLostFlags() {
  const T1 = '2026-07-01T00:00:00.000Z';
  const T2 = '2026-07-02T00:00:00.000Z';

  // 解約と同時に自動付与された合成フラグ（両方とも解約日と同じstamp）→ 消してよい
  assert.equal(
    shouldClearSyntheticLostFlags({ delistedAt: T2, reservationSuspectedAt: T2, reservationLostAt: T2 }),
    true, '解約起因の合成フラグ（両方とも解約日と同じ）: true');

  // 解約前から独立して確認済みだった予約不可（タイムスタンプが解約日と異なる）→ 消してはいけない
  assert.equal(
    shouldClearSyntheticLostFlags({ delistedAt: T2, reservationSuspectedAt: T1, reservationLostAt: T1 }),
    false, '解約前から独立して確認済みの予約不可: false（本物のシグナルなので保持）');

  // 疑い（1回目）だけが解約日と一致し確定はまだ、というケースは無い想定だが念のため
  assert.equal(
    shouldClearSyntheticLostFlags({ delistedAt: T2, reservationSuspectedAt: T2, reservationLostAt: undefined }),
    false, 'reservationLostAt無し: false');

  // 解約自体していない店は対象外
  assert.equal(
    shouldClearSyntheticLostFlags({ reservationSuspectedAt: T1, reservationLostAt: T1 }),
    false, 'delistedAt無し: false');

  ok('shouldClearSyntheticLostFlags: 単体テスト 4/4 パス');
}

// ── ①'''''normalizeAddress/groupByAddress単体テスト（CLI出力の重複統合。index.htmlの複製元） ──
function testAddressDedup() {
  // 全角/半角数字・スペース有無・「丁目」表記の揺れを吸収して同一店舗と判定できること
  assert.equal(normalizeAddress('千葉県松戸市松戸１３０７ー１'), normalizeAddress('千葉県松戸市松戸1307-1'),
    '全角/半角数字・長音記号の表記ゆれを同一視できる');
  assert.equal(normalizeAddress('東京都新宿区西新宿２丁目８－１'), normalizeAddress('東京都新宿区西新宿2-8-1'),
    '「丁目」表記の有無を同一視できる');
  assert.equal(normalizeAddress('東京都 新宿区 西新宿'), normalizeAddress('東京都新宿区西新宿'),
    'スペースの有無を同一視できる');

  // groupByAddress: 同一住所（表記ゆれ含む）の店を1グループに束ね、代表は日付が新しい方
  {
    const items = [
      { id: 'A', address: '千葉県松戸市松戸1307-1', delistedAt: '2026-07-17' },
      { id: 'B', address: '千葉県松戸市松戸１３０７ー１', delistedAt: '2026-07-18' }, // 表記ゆれだが同一住所、日付は新しい
      { id: 'C', address: '千葉県千葉市中央区富士見1-1-1', delistedAt: '2026-07-16' }, // 別住所
    ];
    const groups = groupByAddress(items, 'delistedAt');
    assert.equal(groups.length, 2, '同一住所（表記ゆれ含む）の2件を1グループに束ね、別住所と合わせて2グループになる');
    const matsudoGroup = groups.find(g => g.items.some(it => it.id === 'A'));
    assert.equal(matsudoGroup.items.length, 2, '松戸のグループは2件束ねられている');
    assert.equal(matsudoGroup.primary.id, 'B', '代表は日付が新しい方（B）');
  }
  // 住所が無い店は束ねずID単位で個別扱いする
  {
    const items = [{ id: 'D', address: '', delistedAt: '2026-07-15' }, { id: 'E', address: '', delistedAt: '2026-07-15' }];
    const groups = groupByAddress(items, 'delistedAt');
    assert.equal(groups.length, 2, '住所が無い店同士は束ねない');
  }

  ok('normalizeAddress/groupByAddress: 単体テスト 5/5 パス');
}

// ── ①''''''buildSlackMessage単体テスト（エリア担当者向けSlack通知の本文組み立て） ──
function testBuildSlackMessage() {
  const pref = { id: 'chiba', name: '千葉県' };

  // 何も検出が無ければ通知しない（null）
  assert.equal(
    buildSlackMessage(pref, { lost: [], delisted: [], newlyListed: [] }),
    null, '検出0件: nullを返し通知しない');

  // 検出があれば県名・件数・店名・リンクを含む本文を組み立てる
  {
    const text = buildSlackMessage(pref, {
      lost: [{ name: 'A店', area: '松戸', url: 'https://www.hotpepper.jp/strA/' }],
      delisted: [],
      newlyListed: [],
    });
    assert.ok(text.includes('千葉県'), '県名を含む');
    assert.ok(text.includes('予約不可'), 'ラベル（予約不可）を含む');
    assert.ok(text.includes('1件'), '件数を含む');
    assert.ok(text.includes('A店'), '店名を含む');
    assert.ok(text.includes('https://www.hotpepper.jp/strA/'), 'リンクを含む');
    assert.ok(text.includes('https://wa-ra-so.github.io/hppzaiko/?pref=chiba'), 'サイトURL（該当県）を含む');
  }

  // 件数が上限を超えた分は「…他N件」に丸める（Slackメッセージの肥大防止）
  {
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `店${i}`, area: '', url: `https://example.test/${i}` }));
    const text = buildSlackMessage(pref, { lost: [], delisted: many, newlyListed: [] });
    assert.ok(text.includes('他 5 件'), '上限超過分は「他N件」に丸める');
  }

  ok('buildSlackMessage: 単体テスト 3/3 パス');
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
  // staleRunsは今回のフィールド追加以降にしか付かないため、無い（既存データ）場合は許容する
  assert.ok(json.staleRuns === undefined || (Number.isFinite(json.staleRuns) && json.staleRuns >= 0),
    `${file}: staleRuns must be a non-negative number when present`);
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
    if (s.newlyListedAt) {
      // newlyListedAtはfirstSeenAtと同時に一度だけ記録される値のはず
      assert.equal(s.newlyListedAt, s.firstSeenAt, `${file}: shop ${id} newlyListedAt must equal firstSeenAt`);
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

async function checkNewlyListed(pref, roster, excludedIds) {
  const file = pref.dataFile.replace(/^stores/, 'hotpepper-newly-listed');
  const json = await loadJson(file);
  assert.equal(json.pref, pref.id, `${file}: pref must be "${pref.id}"`);
  assert.ok(Array.isArray(json.items), `${file}: items must be an array`);
  for (const it of json.items) {
    for (const field of ['id', 'name', 'newlyListedAt']) {
      assert.ok(field in it, `${file}: item missing "${field}"`);
    }
    assert.ok(!excludedIds.has(it.id), `${file}: item ${it.id} is in manual-overrides excludedIds but still published`);
    assert.equal(it.reservable, true, `${file}: item ${it.id} has newlyListedAt but reservable !== true`);
  }
  // 軽量抽出版は「台帳の newlyListedAt かつ reservable:true 件数」から「手動除外件数」を
  // 引いたものと一致するはず
  const rosterNewlyListedIds = Object.entries(roster.shops)
    .filter(([, s]) => !!s.newlyListedAt && s.reservable === true)
    .map(([id]) => id);
  const expectedCount = rosterNewlyListedIds.filter(id => !excludedIds.has(id)).length;
  assert.equal(json.items.length, expectedCount,
    `${file}: items.length (${json.items.length}) must match roster newlyListedAt+reservable count minus manual overrides (${expectedCount})`);
  ok(`${file}: ${json.items.length} 件の新規掲載リストを検証（台帳と一致）`);
}

async function main() {
  testApplyReservableCheck();
  await testCheckReservable();
  testExtractPhone();
  testHasMinDelistedTenure();
  testIsBootstrapRun();
  testShouldClearSyntheticLostFlags();
  testAddressDedup();
  testBuildSlackMessage();

  const excludedIds = await loadExcludedIds();
  for (const pref of Object.values(PREFECTURES)) {
    try {
      const roster = await checkRoster(pref);
      await checkLost(pref, roster, excludedIds);
      await checkDelisted(pref, roster, excludedIds);
      await checkNewlyListed(pref, roster, excludedIds);
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
