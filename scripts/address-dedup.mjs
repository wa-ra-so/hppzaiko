// 住所ベースの重複統合ロジック（CLIスクリプト共通）。
// 同じ物理店舗がホットペッパー上で複数の店舗ID（表記ゆれ・過去の再登録等）を持っている
// ケースがあり、束ねないと同じ店が何件も営業リードとして重複表示されてしまう。
// index.html（ブラウザ側）にも同じロジックの複製がある（単一HTMLファイルで完結させる
// 方針のためimportできない）。挙動を変える場合は両方を更新すること。
export function normalizeAddress(addr) {
  return String(addr || '')
    .replace(/[\s　]/g, '')
    .replace(/丁目/g, '-')
    .replace(/[－ー―]/g, '-')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// itemsを住所で束ねてグループ化する。group.primary は最新の日付を持つ代表店、
// group.items は束ねた全件（重複掲載を含む）
export function groupByAddress(items, dateField) {
  const map = new Map();
  for (const it of items) {
    const key = normalizeAddress(it.address) || `id:${it.id}`; // 住所が無い場合は束ねない
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return [...map.values()].map(members => {
    const sorted = [...members].sort((a, b) => (a[dateField] < b[dateField] ? 1 : -1));
    return { items: sorted, primary: sorted[0], date: sorted[0][dateField] };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));
}
