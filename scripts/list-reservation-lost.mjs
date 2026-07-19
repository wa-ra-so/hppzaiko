// 掲載台帳（data/hotpepper-roster*.json）から「ネット予約ができなくなった店」
// ＝以前はホットペッパーのネット予約カレンダーが使えたのに、今は使えなくなった店を
// アタックリストとして出力する。data/manual-overrides.json で手動除外された店は含めない。
// 同じ物理店舗が複数の店舗IDを持つケースは住所ベースで束ね、index.htmlと同じく1軒として扱う。
//
// 使い方:
//   node scripts/list-reservation-lost.mjs --pref=chiba            # 直近90日を表示
//   node scripts/list-reservation-lost.mjs --pref=chiba --days=30  # 期間を変更
//   node scripts/list-reservation-lost.mjs --pref=chiba --csv=attack-list.csv  # CSVも書き出す
//
// APIキー不要（台帳を読むだけ）。台帳は scripts/hotpepper-roster.mjs が1日24回更新する。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPrefFromArgv } from './prefectures.mjs';
import { loadManualOverrides } from './hotpepper-roster.mjs';
import { groupByAddress } from './address-dedup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_PREF = getPrefFromArgv();
const ROSTER_PATH = path.join(__dirname, '..', 'data', ACTIVE_PREF.dataFile.replace(/^stores/, 'hotpepper-roster'));

function getArg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const DAYS = Math.max(1, +getArg('days', '90') || 90);
const CSV_PATH = getArg('csv', '');

function fmtDate(iso) {
  return (iso || '').slice(0, 10);
}

async function main() {
  let roster;
  try {
    roster = JSON.parse(await readFile(ROSTER_PATH, 'utf-8'));
  } catch {
    console.error(`[error] 台帳がありません: ${ROSTER_PATH}`);
    console.error('  まず scripts/hotpepper-roster.mjs を実行して台帳を作成してください。');
    process.exit(1);
  }
  const { updatedAt = '', shops = {} } = roster;
  const excludedIds = await loadManualOverrides();
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  const lostRaw = Object.entries(shops)
    .filter(([id, s]) => s.reservationLostAt && Date.parse(s.reservationLostAt) >= cutoff && !excludedIds.has(id))
    .map(([id, s]) => ({ id, ...s }));
  const groups = groupByAddress(lostRaw, 'reservationLostAt');
  const dupCount = lostRaw.length - groups.length;

  console.log(`■ ${ACTIVE_PREF.name} ネット予約不可になった店（直近${DAYS}日 / 台帳更新: ${fmtDate(updatedAt)}）`);
  console.log(`  該当: ${groups.length} 店${dupCount > 0 ? `（同一住所の重複掲載 ${dupCount} 件を集約済み）` : ''}\n`);
  for (const g of groups) {
    const s = g.primary;
    const lastReservableOn = fmtDate(s.lastReservableAt);
    const suspectedOn = fmtDate(s.reservationSuspectedAt) || fmtDate(s.reservationLostAt);
    const lostOn = fmtDate(s.reservationLostAt);
    const range = lastReservableOn ? `${lastReservableOn} 〜 ${suspectedOn} の間` : `${suspectedOn} 以前`;
    console.log(`・${s.name}${s.genre ? `（${s.genre}）` : ''}`);
    console.log(`   ${s.address}`);
    console.log(`   ネット予約不可になった時期: ${range}（正確な日は特定できません。チェックは数日おきのため）`);
    console.log(`   1回目検出: ${suspectedOn} → 2回目確認(確定): ${lostOn} / ページ: ${s.url || `https://www.hotpepper.jp/str${s.id}/`}`);
    if (g.items.length > 1) {
      console.log(`   同一住所に${g.items.length}件の掲載（重複掲載の可能性）: ${g.items.slice(1).map(o => o.name).join(' / ')}`);
    }
  }

  if (CSV_PATH) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['店名', 'ジャンル', 'エリア', '住所', '予約可能を最後に確認した日', '1回目検出日', '2回目確認(確定)日', '同一住所の重複掲載件数', 'ホットペッパーURL'].map(esc).join(','),
      ...groups.map(g => {
        const s = g.primary;
        return [
          s.name, s.genre, s.area, s.address,
          fmtDate(s.lastReservableAt), fmtDate(s.reservationSuspectedAt) || fmtDate(s.reservationLostAt), fmtDate(s.reservationLostAt),
          g.items.length, s.url || `https://www.hotpepper.jp/str${s.id}/`,
        ].map(esc).join(',');
      }),
    ];
    // Excelで文字化けしないようBOM付きUTF-8で出力
    await writeFile(CSV_PATH, '\uFEFF' + rows.join('\r\n'));
    console.log(`\n[info] CSVを書き出しました: ${CSV_PATH}`);
  }
}

main().catch(err => {
  console.error('[error]', err.message || err);
  process.exit(1);
});
