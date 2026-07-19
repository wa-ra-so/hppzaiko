// 掲載台帳（data/hotpepper-roster*.json）から「新しくホットペッパーに掲載され、ネット予約も
// 使える店」を出力する。予約不可・解約の逆で、新規開拓の営業リードとして使う。
// data/manual-overrides.json で手動除外された店は含めない。
// 同じ物理店舗が複数の店舗IDを持つケースは住所ベースで束ね、index.htmlと同じく1軒として扱う。
//
// 使い方:
//   node scripts/list-newly-listed.mjs --pref=chiba            # 直近90日を表示
//   node scripts/list-newly-listed.mjs --pref=chiba --days=30  # 期間を変更
//   node scripts/list-newly-listed.mjs --pref=chiba --csv=newly-listed.csv  # CSVも書き出す
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

  const newlyListedRaw = Object.entries(shops)
    .filter(([id, s]) => s.newlyListedAt && s.reservable === true && Date.parse(s.newlyListedAt) >= cutoff && !excludedIds.has(id))
    .map(([id, s]) => ({ id, ...s }));
  const groups = groupByAddress(newlyListedRaw, 'newlyListedAt');
  const dupCount = newlyListedRaw.length - groups.length;

  console.log(`■ ${ACTIVE_PREF.name} 新規掲載（ネット予約可）の店（直近${DAYS}日 / 台帳更新: ${fmtDate(updatedAt)}）`);
  console.log(`  該当: ${groups.length} 店${dupCount > 0 ? `（同一住所の重複掲載 ${dupCount} 件を集約済み）` : ''}\n`);
  for (const g of groups) {
    const s = g.primary;
    console.log(`・${s.name}${s.genre ? `（${s.genre}）` : ''}`);
    console.log(`   ${s.address}`);
    console.log(`   新規掲載検出: ${fmtDate(s.newlyListedAt)}（全件チェックは実行のたびに走るため、実際の掲載開始とのズレは運用間隔程度です） / ページ: ${s.url || `https://www.hotpepper.jp/str${s.id}/`}`);
    if (g.items.length > 1) {
      console.log(`   同一住所に${g.items.length}件の掲載（重複掲載の可能性）: ${g.items.slice(1).map(o => o.name).join(' / ')}`);
    }
  }

  if (CSV_PATH) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['店名', 'ジャンル', 'エリア', '住所', '新規掲載検出日', '同一住所の重複掲載件数', 'ホットペッパーURL'].map(esc).join(','),
      ...groups.map(g => {
        const s = g.primary;
        return [s.name, s.genre, s.area, s.address, fmtDate(s.newlyListedAt), g.items.length, s.url || `https://www.hotpepper.jp/str${s.id}/`].map(esc).join(',');
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
