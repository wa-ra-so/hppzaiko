// ホットペッパーグルメAPIから対象県の「全掲載店」を取得し、掲載台帳
// data/hotpepper-roster*.json を更新するスクリプト。1日24回Actionsから実行される想定。
//
// 台帳には店舗IDごとに firstSeenAt/lastSeenAt（掲載確認日）に加えて、
// reservable（ネット予約可否）と reservableCheckedAt を記録する。
// catch/budget/open/close/access（キャッチコピー・予算・営業時間・定休日・アクセス）は
// 掲載中の最新値で毎回上書きするため、解約後は「解約前に最後に確認できた店舗情報」として
// 残る（解約リストで架電・商談の参考情報として表示する）。
//
// ネット予約可否はグルメサーチAPIにフィールドが無いため、店舗ページ本体を取得し
// <title> タグの「＜ネット予約可＞」表記の有無で判定する（実ページで確認済み。
// 予約可の店はタイトルに付き、不可の店には付かない）。全店（数千件）を毎回
// チェックすると重いため、未チェック・チェックが古い店から順に1回の実行につき
// RESERVE_CHECK_BATCH 件だけ確認するローテーション方式（1日24回実行）。
//
// 注意: ローテーションのため「予約できなくなった正確な日」はわからない。
// 記録できるのは lastReservableAt（予約可能を最後に確認した日）〜
// reservationLostAt（予約不可を確定した日）という"幅"のみ
// （チェック間隔は千葉県で約1日あるため、実際の変化はこの間のどこか）。
//
// 誤検出防止のため2段階確認方式を採る：
//   1回目にtrue→falseを検出 → reservationSuspectedAt を記録するだけ（まだアタックリストには載せない）
//   次のローテーションでも連続してfalseだった → reservationLostAt を記録し確定（アタックリスト入り）
//   確認前にtrueに戻った → reservationSuspectedAt を削除して疑い解除
// 1回のチェックだけで即断しないのは、bot判定ページ・一時的な障害・ページ構造の
// 揺れなどで<title>の判定が一時的に狂うケースがあるため（詳細はcheckReservable参照）。
// ただし掲載自体が終了した場合（掲載有無チェックは毎日走り信頼度が高い）は2段階を経ず即確定する。
//
// 解約（掲載自体が終了した店）は、予約可否とは別に delistedAt として理由を問わず全件記録する
// （未入金による強制解約など、予約機能を使っていなかった店の解約も取りこぼさないため）。
// gourmet APIの掲載一覧に含まれなくなったことをもって判定するため、<title>スクレイピングより
// 信頼度が高く、2段階確認は不要。予約可だった店の解約は reservationLostAt にも従来どおり計上する。
//
// 新規掲載（ネット予約可）: 解約の逆で、新しくgourmet APIの掲載一覧に現れた店を newlyListedAt
// として記録し、そのうち reservable:true が確認できた店だけを新規掲載リストとして公開する。
// 全件取得（fetchAllShops）は毎回全件走るため、解約検出と違って「見えなくなってから気づく」
// ラグは無く newlyListedAt は掲載開始と同じ運用間隔内の精度を持つ。ただし初回起動（台帳が
// まだ無い最初の実行）で一括登録される店は「新しく掲載された」わけではないため対象外にする
// （isBootstrapRun）。
//
// 使い方: HOTPEPPER_API_KEY=xxx node scripts/hotpepper-roster.mjs --pref=chiba
// 依存パッケージなし（Node 20+ の組み込み fetch のみ使用）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPrefFromArgv } from './prefectures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_PREF = getPrefFromArgv();
// stores.json → hotpepper-roster.json / stores-tokyo.json → hotpepper-roster-tokyo.json
const ROSTER_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile.replace(/^stores/, 'hotpepper-roster'));
// index.html が読む軽量版（予約できなくなった店のみの抽出。台帳本体は大きいため）
const LOST_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile.replace(/^stores/, 'hotpepper-reservation-lost'));
// index.html が読む軽量版（解約＝掲載終了した店のみの抽出。理由（予約可否）を問わず全件）
const DELISTED_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile.replace(/^stores/, 'hotpepper-delisted'));
// index.html が読む軽量版（新規掲載＝新しくホットペッパーに載り、ネット予約も使える店のみの抽出）
const NEWLY_LISTED_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile.replace(/^stores/, 'hotpepper-newly-listed'));
// 誤検出などで手動除外したい店舗IDのリスト（全県共通・店舗IDはHotPepper全体で一意）
export const MANUAL_OVERRIDES_PATH = path.join(__dirname, '..', 'data', 'manual-overrides.json');

const HOTPEPPER_API_KEY = process.env.HOTPEPPER_API_KEY || '';
const API_BASE = 'https://webservice.recruit.co.jp/hotpepper';
const PAGE_SIZE = 100;          // APIの最大件数
// 暴走防止用の上限（100件×1000=10万件まで）。実際にどこかの県がこれに到達することは
// 想定していない（真の安全弁）。旧MAX_PAGES=300（3万件まで）は東京都の実件数がこれを
// 超えており、毎回ちょうど3万件で無言のまま打ち切られ、3万件より後ろの店が「取得できな
// かった店」として扱われて誤って解約判定される事故を起こしていた（2026-07-18発覚）。
// 上限に達した場合は下のwarningで必ず気づけるようにしてある
const MAX_PAGES = 1000;
const PAGE_INTERVAL_MS = 200;   // ページ間の待機（API負荷への配慮）
const KEEP_DAYS = 400;          // 掲載終了店を台帳に残す日数（掃除用）

// ネット予約チェックのローテーション設定（全店を毎日は見ず、少しずつ回す）
const RESERVE_CHECK_BATCH = +(process.env.RESERVE_CHECK_BATCH || 800);
const RESERVE_CHECK_CONCURRENCY = 5;
const RESERVE_PAGE_TIMEOUT_MS = 15000;
const RESERVE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 安全弁: 1回の実行で新たに「予約不可」を確定した件数がこれを超えたら、<title>タグの
// 仕様変更・bot判定など検出ロジックそのものが壊れている可能性が高いとみなし、
// 台帳を更新せず中断する（通常は1回の実行で多くても数件程度）。
const LOST_SURGE_ABS_THRESHOLD = 20;
const LOST_SURGE_RATIO_THRESHOLD = 0.1; // チェック数に対する割合

// 解約判定に必要な最低観測期間（firstSeenAt〜lastSeenAtの幅）。新規掲載直後の店は
// 開店準備中のページ変動やAPI取得のブレで一時的に消えて見えることがあり、これを
// 「解約」と誤判定しないため、一定期間継続して掲載が確認できていた店のみを対象にする。
const MIN_DELISTED_TENURE_MS = 48 * 60 * 60 * 1000; // 48時間

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function apiGet(pathname, params) {
  const qs = new URLSearchParams({ key: HOTPEPPER_API_KEY, format: 'json', ...params });
  const res = await fetch(`${API_BASE}/${pathname}/v1/?${qs}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`hotpepper ${pathname} HTTP ${res.status}`);
  const json = await res.json();
  if (json.results && json.results.error) {
    const e = [].concat(json.results.error)[0] || {};
    throw new Error(`hotpepper ${pathname} API error ${e.code || ''}: ${e.message || 'unknown'}`);
  }
  return json.results || {};
}

// 県名から大エリアコード（Z0XX）を動的に解決する（コードのハードコードを避ける）
async function resolveLargeArea(pref) {
  const results = await apiGet('large_area', {});
  const list = (results.large_area || []).filter(a => (a.name || '').includes(pref.short));
  if (list.length === 0) throw new Error(`large_area not found for ${pref.name}`);
  return list.map(a => ({ code: a.code, name: a.name }));
}

// 対象県の全掲載店をページングで取得
async function fetchAllShops(largeAreas) {
  const shops = new Map(); // id -> shop
  for (const area of largeAreas) {
    let start = 1;
    let page = 0;
    for (; page < MAX_PAGES; page++) {
      const results = await apiGet('gourmet', {
        large_area: area.code, count: String(PAGE_SIZE), start: String(start),
      });
      const batch = results.shop || [];
      const available = +results.results_available || 0;
      for (const s of batch) {
        if (!s.id) continue;
        shops.set(s.id, {
          name: s.name || '',
          address: s.address || '',
          genre: (s.genre && s.genre.name) || '',
          area: (s.small_area && s.small_area.name) || (s.middle_area && s.middle_area.name) || '',
          url: (s.urls && s.urls.pc) || `https://www.hotpepper.jp/str${s.id}/`,
          // 解約後は店舗ページ自体が見られなくなるため、掲載中に取得できるこれらの情報は
          // 毎回上書き保存しておく。解約検出時点でその店の「最後に確認できた姿」として
          // 公開用リストに残り、架電・商談時の参考情報になる
          catch: s.catch || '',
          budget: (s.budget && (s.budget.average || s.budget.name)) || '',
          open: s.open || '',
          close: s.close || '',
          access: s.access || '',
        });
      }
      start += batch.length;
      if (batch.length === 0 || start > available) break;
      await sleep(PAGE_INTERVAL_MS);
    }
    // for が自然breakせずMAX_PAGESを使い切った＝まだ続きがあるのに打ち切った可能性が高い。
    // 黙って切り捨てると、切り捨てられた店が「見えなくなった店」として誤って解約判定
    // されてしまう（実際に東京都でMAX_PAGES=300のとき発生した）ため、必ず目立つ警告を出す
    if (page >= MAX_PAGES) {
      console.log(`::warning::${area.name}(${area.code}): MAX_PAGES（${MAX_PAGES}）に到達し取得を打ち切りました。実際の掲載件数が上限を超えている可能性が高く、以降このエリアの店が誤って解約判定される恐れがあります。MAX_PAGESの引き上げを検討してください`);
    }
    console.log(`[info] ${area.name}(${area.code}): 累計 ${shops.size} 店`);
  }
  return shops;
}

// 店舗ページの <title> にある「＜ネット予約可＞」表記の有無でネット予約可否を判定する。
// true/false が返らずnull（判定不能）になるのは以下のいずれか：
//   - ページ取得に失敗した（HTTPエラー・タイムアウト等）
//   - <title>が見つからない（bot判定ページ等、想定外のページが返ってきた）
//   - <title>に「ネット予約可」が無いが、本文にも「現在ネット予約を受け付けていません」の
//     裏取り文言が無い（HotPepper側のタイトル表記仕様が変わった可能性があるため、
//     ここで false と決め打ちせず判定不能として今回はスキップする）
// 判定不能時は既存の台帳の状態を壊さない（reservableを更新しない）。
export async function checkReservable(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': RESERVE_UA },
      cache: 'no-store', // 中間キャッシュ経由で古いページを拾わないようにする
      signal: AbortSignal.timeout(RESERVE_PAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) return null;
    if (m[1].includes('ネット予約可')) return true;
    // タイトルに「ネット予約可」が無い＝不可の可能性。本文の実際の予約不可メッセージでも
    // 裏取りできた場合のみ false とする（タイトル表記だけに依存しないための二重チェック）
    if (html.includes('現在ネット予約を受け付けていません')) return false;
    return null;
  } catch {
    return null;
  }
}

// 1件分のチェック結果を店舗レコードへ反映する（テスト容易化のため純粋関数として分離）。
// 2段階確認方式:
//   true                                → 確定/疑いを解除し reservable:true に
//   false かつ 前回 reservable:true      → 1回目の検出。reservationSuspectedAt を記録するのみ
//   false かつ 疑い中（未確定）           → 2回目の連続検出。reservationLostAt を記録し確定
//   false かつ 既に確定済み／元々予約なし  → reservableCheckedAt のみ更新
export function applyReservableCheck(shop, result, stamp) {
  if (result === true) {
    const next = { ...shop, reservable: true, reservableCheckedAt: stamp, lastReservableAt: stamp };
    delete next.reservationSuspectedAt;
    delete next.reservationLostAt;
    return { shop: next, newlyConfirmedLost: false };
  }
  const wasReservable = shop.reservable;
  if (wasReservable === true) {
    return {
      shop: { ...shop, reservable: false, reservableCheckedAt: stamp, reservationSuspectedAt: stamp },
      newlyConfirmedLost: false,
    };
  }
  if (wasReservable === false && shop.reservationSuspectedAt && !shop.reservationLostAt) {
    return {
      shop: { ...shop, reservable: false, reservableCheckedAt: stamp, reservationLostAt: stamp },
      newlyConfirmedLost: true,
    };
  }
  // wasReservable が undefined（初回チェック）で result が false の場合は
  // 「元々ネット予約なし」の可能性が高く、予約"できなくなった"わけではないため対象外。
  // 既に確定済みの店はチェック日だけ更新し、reservationLostAt（初回確定日）は保持する。
  return {
    shop: { ...shop, reservable: false, reservableCheckedAt: stamp },
    newlyConfirmedLost: false,
  };
}

// 解約と判定してよいだけの観測期間（firstSeenAt〜lastSeenAt）が確保できているか。
// 新規掲載直後の店を「解約」と誤判定しないための下限チェック（テスト容易化のため分離）。
// 注意: Date.parse(0) は数値0が文字列"0"としてパースされ2000年扱いになる（NaNにならない）ため、
// `|| 0` のようなフォールバックは使わず、欠損時は明示的にfalse側へ倒す。
export function hasMinDelistedTenure(shop) {
  const first = Date.parse(shop.firstSeenAt);
  const last = Date.parse(shop.lastSeenAt);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  return (last - first) >= MIN_DELISTED_TENURE_MS;
}

// prev.updatedAt が空文字＝台帳がまだ存在しない最初の実行（初回起動／このリポジトリの
// 初期データ移行）を意味する。その回に取得した店は「新しくホットペッパーに掲載された」の
// ではなく単なる初期の一括取り込みなので、新規掲載として記録してはいけない
// （じげもんちゃんぽんの解約検出で「最終掲載確認〜検出のズレが実際の変化のタイミングとは
// 限らない」と判明したのと対称の問題: 初回起動時に一括登録された店は全店が同じ
// firstSeenAtを持つため、これを新規掲載扱いすると初回起動直後の「直近7日」等の期間
// フィルタに数千件が「新規掲載」として現れてしまう）。
export function isBootstrapRun(prevUpdatedAt) {
  return !prevUpdatedAt;
}

async function loadRoster() {
  try {
    const json = JSON.parse(await readFile(ROSTER_PATH, 'utf-8'));
    return {
      updatedAt: json.updatedAt || '',
      shops: json.shops && typeof json.shops === 'object' ? json.shops : {},
    };
  } catch {
    return { updatedAt: '', shops: {} };
  }
}

export async function loadManualOverrides() {
  try {
    const json = JSON.parse(await readFile(MANUAL_OVERRIDES_PATH, 'utf-8'));
    return new Set(Array.isArray(json.excludedIds) ? json.excludedIds : []);
  } catch {
    return new Set();
  }
}

export async function main() {
  if (!HOTPEPPER_API_KEY) {
    console.log('[info] HOTPEPPER_API_KEY not set; skipping roster update');
    return;
  }
  const stamp = new Date().toISOString();
  const prev = await loadRoster();
  const prevActive = Object.values(prev.shops).filter(s => s.lastSeenAt === prev.updatedAt).length;
  const excludedIds = await loadManualOverrides();

  const largeAreas = await resolveLargeArea(ACTIVE_PREF);
  console.log(`[info] ${ACTIVE_PREF.name} の大エリア: ${largeAreas.map(a => `${a.name}=${a.code}`).join(', ')}`);
  const current = await fetchAllShops(largeAreas);
  console.log(`[info] 現在の掲載店数: ${current.size}（前回 ${prevActive}）`);

  // 安全弁: 取得数が前回の半分未満ならAPI不調とみなし、台帳を更新しない
  // （大量の店を誤って「掲載終了」と判定しないため）
  if (current.size === 0 || (prevActive > 0 && current.size < prevActive * 0.5)) {
    throw new Error(`fetched ${current.size} shops (prev ${prevActive}); aborting roster update`);
  }

  const bootstrap = isBootstrapRun(prev.updatedAt);

  // 台帳へマージ: 今回見えた店は掲載情報とlastSeenAtを更新、見えなかった店はそのまま残す
  const shops = { ...prev.shops };
  let added = 0;
  for (const [id, s] of current) {
    if (!shops[id]) {
      shops[id] = { ...s, firstSeenAt: stamp, lastSeenAt: stamp };
      if (!bootstrap) shops[id].newlyListedAt = stamp; // 新規掲載検出（初回起動時の一括登録は除く）
      added++;
    } else {
      // reservable系フィールドは維持しつつ、掲載情報だけ更新
      shops[id] = { ...shops[id], ...s, lastSeenAt: stamp };
      if (shops[id].delistedAt) delete shops[id].delistedAt; // 再掲載＝解約から復帰
    }
  }

  // ── ネット予約可否チェック（ローテーション） ──
  // 掲載中の店のうち、①現在アタックリストに載っている店・疑い中の店を毎回優先的に
  // 再チェックし、②残り枠は未チェック・チェックが古い店から順に確認する。
  // ①を優先しないと、予約可能に戻った店が次に選ばれるまで（東京なら最大2週間ほど）
  // アタックリストに載ったままになってしまう。また疑い中の店（1回目検出済み）を
  // 優先することで、2回目の確認（確定 or 解除）もできるだけ早く行われるようにする。
  const listedIds = Object.keys(shops).filter(id => shops[id].lastSeenAt === stamp);
  const byCheckedAtAsc = (a, b) => Date.parse(shops[a].reservableCheckedAt || 0) - Date.parse(shops[b].reservableCheckedAt || 0);
  const priorityIds = listedIds.filter(id => shops[id].reservationLostAt || shops[id].reservationSuspectedAt).sort(byCheckedAtAsc);
  const restIds = listedIds.filter(id => !shops[id].reservationLostAt && !shops[id].reservationSuspectedAt).sort(byCheckedAtAsc);
  const checkQueue = [...priorityIds, ...restIds].slice(0, RESERVE_CHECK_BATCH);
  console.log(`[info] ネット予約チェック対象: ${checkQueue.length} 件（掲載中 ${listedIds.length} 件中、優先再チェック ${priorityIds.length} 件）`);

  const reservationLostNow = [];
  const newlySuspected = [];
  let newlyConfirmedFromCheck = 0;
  let checkedOk = 0;
  let checkFailed = 0;
  await mapWithConcurrency(checkQueue, RESERVE_CHECK_CONCURRENCY, async (id) => {
    const s = shops[id];
    const result = await checkReservable(s.url);
    if (result === null) { checkFailed++; return; }
    checkedOk++;
    const { shop: updated, newlyConfirmedLost } = applyReservableCheck(s, result, stamp);
    shops[id] = updated;
    if (newlyConfirmedLost) {
      newlyConfirmedFromCheck++;
      reservationLostNow.push({ id, ...updated });
    } else if (result === false && updated.reservationSuspectedAt && updated.reservationSuspectedAt === stamp) {
      newlySuspected.push({ id, ...updated });
    }
  });
  console.log(`[info] ネット予約チェック結果: 成功 ${checkedOk} / 失敗 ${checkFailed}`);
  if (newlySuspected.length > 0) {
    console.log(`[info] 今回新たに「予約不可の疑い」を検出（1回目・まだアタックリスト未掲載）: ${newlySuspected.length} 店`);
    for (const s of newlySuspected) console.log(`  - ${s.name}（${s.area || s.address}） ${s.url}`);
  }
  if (reservationLostNow.length > 0) {
    console.log(`[info] 今回新たにネット予約不可を確定（2回目）: ${reservationLostNow.length} 店`);
    for (const s of reservationLostNow) {
      const range = s.lastReservableAt ? `${s.lastReservableAt.slice(0, 10)} 〜 ${s.reservationLostAt.slice(0, 10)}` : `〜${s.reservationLostAt.slice(0, 10)}`;
      console.log(`  - ${s.name}（${s.area || s.address}） ${range} ${s.url}`);
    }
  }

  // 安全弁: <title>タグの仕様変更・bot判定などで検出ロジック自体が壊れていると、
  // 一斉に「予約不可」の誤検出が発生しうる。異常な件数が確定した場合は台帳を更新しない
  const surgeThreshold = Math.max(LOST_SURGE_ABS_THRESHOLD, checkQueue.length * LOST_SURGE_RATIO_THRESHOLD);
  if (newlyConfirmedFromCheck > surgeThreshold) {
    throw new Error(`newly confirmed reservation-lost surge: ${newlyConfirmedFromCheck} (checked ${checkQueue.length}, threshold ${Math.round(surgeThreshold)}); aborting roster update — possible detection logic breakage`);
  }

  // 掲載終了店（今回の取得結果に含まれなかった店）＝解約。理由（予約可否）を問わず、
  // まだ delistedAt が付いていない店を検出する。「前回からの遷移」ではなく「今回時点で
  // まだ掲載中と確認できず、かつ未記録」を条件にしているのは、途中の実行が失敗・スキップ
  // された場合でも取りこぼさないため（前回比較だけだと、消えた直後の1回だけしか検出
  // チャンスが無く、その回に安全弁で中断する等があると永久に見逃してしまう）。
  // 掲載有無チェックは毎日走り信頼度が高いため、ここは2段階確認を経ず即確定する。
  // ただし新規掲載直後（firstSeenAt〜lastSeenAtがMIN_DELISTED_TENURE_MS未満）の店は対象外にする
  // ＝開店準備中のページ変動やAPI取得のブレを「解約」と誤判定しないため（一定期間の継続掲載を
  // 確認できて初めて、消えたことが意味のあるシグナルになる）。
  // 予約可だった店の解約は、従来どおり「予約できなくなった」（reservationLostAt）にも計上する
  // （解約＝当然ネット予約もできなくなるため、予約不可リスト側にも引き続き載せる）。
  const newlyDelisted = Object.entries(shops).filter(([, s]) =>
    s.lastSeenAt !== stamp && !s.delistedAt && hasMinDelistedTenure(s));
  const newlyDelistedRecords = [];
  const newlyDelistedLost = [];
  for (const [id, s] of newlyDelisted) {
    shops[id] = { ...s, delistedAt: stamp };
    newlyDelistedRecords.push(shops[id]);
    if (s.reservable === true) {
      shops[id] = { ...shops[id], reservable: false, reservationSuspectedAt: s.reservationSuspectedAt || stamp, reservationLostAt: stamp };
      reservationLostNow.push({ id, ...shops[id] });
      newlyDelistedLost.push(shops[id]);
    }
  }
  // 安全弁: API取得の一時的な不調（一部ページだけ欠落等）で大量の店を誤って「解約」と
  // 判定してしまう可能性がある（current.size < prevActive * 0.5 ほど極端でない中規模の
  // 欠落を捕捉するための追加の安全弁）
  const delistedSurgeThreshold = Math.max(LOST_SURGE_ABS_THRESHOLD, prevActive * LOST_SURGE_RATIO_THRESHOLD);
  if (newlyDelisted.length > delistedSurgeThreshold) {
    throw new Error(`newly delisted surge: ${newlyDelisted.length} (prev active ${prevActive}, threshold ${Math.round(delistedSurgeThreshold)}); aborting roster update — possible fetch/pagination failure`);
  }
  if (newlyDelistedRecords.length > 0) {
    console.log(`[info] 今回新たに解約（掲載終了）を検出: ${newlyDelistedRecords.length} 店（うち予約可だった店 ${newlyDelistedLost.length} 店）`);
    for (const s of newlyDelistedRecords) {
      console.log(`  - ${s.name}（${s.area || s.address}） 最終掲載確認: ${(s.lastSeenAt || '').slice(0, 10)} → 解約検出: ${s.delistedAt.slice(0, 10)} ${s.url}`);
    }
  }

  // 今回新たに掲載され、かつネット予約チェックで reservable:true まで確認できた店
  // （新規掲載自体は上のマージ時点でわかるが、予約可否はローテーションチェック待ちのため
  // 別run跨ぎで確定することもある）
  const newlyListedNow = Object.entries(shops)
    .filter(([, s]) => s.newlyListedAt === stamp && s.reservable === true)
    .map(([id, s]) => ({ id, ...s }));
  if (newlyListedNow.length > 0) {
    console.log(`[info] 今回新たに新規掲載（ネット予約可）を検出: ${newlyListedNow.length} 店`);
    for (const s of newlyListedNow) console.log(`  - ${s.name}（${s.area || s.address}） ${s.url}`);
  }

  // 掲載終了から一定日数を過ぎた店は台帳から掃除（ファイル肥大防止）
  const keepCutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [id, s] of Object.entries(shops)) {
    if (s.lastSeenAt !== stamp && Date.parse(s.lastSeenAt || 0) < keepCutoff) {
      delete shops[id];
      pruned++;
    }
  }

  const reservationLostAllRaw = Object.entries(shops)
    .filter(([, s]) => !!s.reservationLostAt)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (a.reservationLostAt < b.reservationLostAt ? 1 : -1));
  const delistedAllRaw = Object.entries(shops)
    .filter(([, s]) => !!s.delistedAt)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (a.delistedAt < b.delistedAt ? 1 : -1));
  // 新規掲載（ネット予約可）: newlyListedAt（初回起動時の一括登録を除く新規掲載日）が付いていて、
  // かつ現時点で reservable:true が確認できている店のみ。予約可否は後から変わりうるため、
  // 過去に一度trueだったかではなく「現在も」trueであることを条件にする
  const newlyListedAllRaw = Object.entries(shops)
    .filter(([, s]) => !!s.newlyListedAt && s.reservable === true)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (a.newlyListedAt < b.newlyListedAt ? 1 : -1));
  // 手動除外（誤検出などをdata/manual-overrides.jsonでピンポイントに外す）。
  // 台帳（ROSTER_PATH）には残し、公開用のリスト（LOST_PATH/DELISTED_PATH/NEWLY_LISTED_PATH）
  // からのみ除外する
  const reservationLostAll = reservationLostAllRaw.filter(s => !excludedIds.has(s.id));
  const delistedAll = delistedAllRaw.filter(s => !excludedIds.has(s.id));
  const newlyListedAll = newlyListedAllRaw.filter(s => !excludedIds.has(s.id));
  const excludedCount = reservationLostAllRaw.length - reservationLostAll.length;

  await mkdir(path.dirname(ROSTER_PATH), { recursive: true });
  await writeFile(ROSTER_PATH, JSON.stringify({
    updatedAt: stamp,
    pref: ACTIVE_PREF.id,
    activeCount: current.size,
    reservationLostCount: reservationLostAllRaw.length,
    delistedCount: delistedAllRaw.length,
    newlyListedCount: newlyListedAllRaw.length,
    shops,
  }, null, 1));
  // アタックリスト画面（index.html）用の軽量抽出
  await writeFile(LOST_PATH, JSON.stringify({
    updatedAt: stamp,
    pref: ACTIVE_PREF.id,
    activeCount: current.size,
    items: reservationLostAll,
  }, null, 1));
  // 解約（掲載終了）リスト画面（index.html）用の軽量抽出
  await writeFile(DELISTED_PATH, JSON.stringify({
    updatedAt: stamp,
    pref: ACTIVE_PREF.id,
    activeCount: current.size,
    items: delistedAll,
  }, null, 1));
  // 新規掲載（ネット予約可）リスト画面（index.html）用の軽量抽出
  await writeFile(NEWLY_LISTED_PATH, JSON.stringify({
    updatedAt: stamp,
    pref: ACTIVE_PREF.id,
    activeCount: current.size,
    items: newlyListedAll,
  }, null, 1));
  console.log(`[info] 台帳更新: 掲載中 ${current.size} / 新規 ${added} / 予約不可(累計) ${reservationLostAllRaw.length}（手動除外 ${excludedCount}） / 解約(累計) ${delistedAllRaw.length} / 新規掲載(予約可,累計) ${newlyListedAllRaw.length} / 疑い中 ${listedIds.filter(id => shops[id].reservationSuspectedAt && !shops[id].reservationLostAt).length} / 掃除 ${pruned}`);
  console.log(`[info] wrote ${ROSTER_PATH} / ${LOST_PATH} / ${DELISTED_PATH} / ${NEWLY_LISTED_PATH}`);
}

// このファイルが直接実行された場合のみ main() を走らせる（test-data.mjs から
// applyReservableCheck / checkReservable / loadManualOverrides を import するだけで
// 実際の台帳更新が走ってしまわないようにするため）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[error]', err.message || err);
    process.exit(1);
  });
}
