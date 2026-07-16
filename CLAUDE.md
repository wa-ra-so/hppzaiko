# ホットペッパー在庫 / アタックリスト（千葉・東京・神奈川・埼玉）

食べログ営業のメンバーが使う営業支援ツール。ホットペッパーグルメの掲載店台帳を
1日3回自動更新し、「ネット予約カレンダーが使えなくなった店」「解約（掲載自体が
終了した店）」の2種類のアタック対象をGitHub Pagesで一覧表示する。
**依存パッケージなし**（Node 20+の組み込みfetchのみ）。

姉妹リポジトリ [`sinntenn`](https://github.com/wa-ra-so/sinntenn) から
アタックリスト機能を分離したもの（2026-07）。新店リサーチ側の更新ワークフローが
台帳更新（1日3回×4県×800件のローテーションチェック）とバッティングして重くなって
いたため、ワークフロー・データを完全に別リポジトリへ分けた。**sinntennは新店リサーチ
のみ、hppzaikoはアタックリストのみを担当する。**

- 公開URL: https://wa-ra-so.github.io/hppzaiko/ （千葉県・デフォルト）
  - 東京都: `?pref=tokyo` / 神奈川県: `?pref=kanagawa` / 埼玉県: `?pref=saitama`
- 新店リサーチ（姉妹ツール）: https://wa-ra-so.github.io/sinntenn/

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | アタックリスト画面。「予約不可」「解約（掲載終了）」の2タブ切り替え式（期間・エリア・ジャンル絞り込み、CSV保存）。`data/hotpepper-reservation-lost*.json`/`data/hotpepper-delisted*.json` を表示。旧 `sinntenn/attack.html` |
| `scripts/prefectures.mjs` | 対象県設定（id/name/short/dataFile）。sinntenn側の同名ファイルとは別物（エリア判定用のaliasesは不要なため簡略版） |
| `scripts/hotpepper-roster.mjs` | ホットペッパー全掲載店の台帳更新＋ネット予約可否チェック＋解約（掲載終了）検出（`--pref=`で県指定）。Actionsから1日3回、4県分実行 |
| `scripts/list-reservation-lost.mjs` | 台帳からネット予約不可になった店をCLI出力・CSV書き出しするヘルパー |
| `scripts/list-delisted.mjs` | 台帳から解約（掲載終了）した店をCLI出力・CSV書き出しするヘルパー |
| `scripts/test-data.mjs` | 判定ロジック（`applyReservableCheck`/`checkReservable`）の単体テスト＋`data/*.json` の整合性チェック。台帳更新の前後でActionsから実行し、ロジックの劣化や壊れたデータをコミットしない |
| `data/hotpepper-roster*.json` | 県ごとのホットペッパー掲載台帳（店舗IDごとの firstSeenAt / lastSeenAt / reservable / reservableCheckedAt / lastReservableAt / reservationSuspectedAt / reservationLostAt / delistedAt。Actionsが自動コミット） |
| `data/hotpepper-reservation-lost*.json` | 台帳から抽出したネット予約不可店（確定分・手動除外を除く）のみの軽量版（`index.html` が読む） |
| `data/hotpepper-delisted*.json` | 台帳から抽出した解約（掲載終了）店（手動除外を除く）のみの軽量版（`index.html` が読む） |
| `data/manual-overrides.json` | 誤検出などを手動でアタックリストから除外するための除外店舗IDリスト（全県共通） |

## データソース・判定ロジック（hotpepper-roster.mjs）

ホットペッパーグルメAPI（`HOTPEPPER_API_KEY` シークレット設定時のみ）で対象県の
全掲載店を取得し、店舗ページ本体を取得して `<title>` タグの「＜ネット予約可＞」
表記の有無でネット予約可否を判定する（グルメサーチAPIにはこのフィールドが無い）。

全店を毎回チェックすると重いため、未チェック・チェックが古い店から1回の実行につき
800件ローテーションで確認（1日3回×800件＝2,400件／日／県。千葉・埼玉は約2〜3日、
神奈川は約4日、店舗数の多い東京は約2週間で一巡）。

台帳の記録は2026-07-14開始（東京・神奈川・埼玉は2026-07-15開始）で、それ以前には
遡れない。分離後もこの記録は引き継いでいる（sinntennから移行したデータをそのまま
コミット）。

## 解約（掲載終了）検出

「予約不可」は掲載を続けたままネット予約機能だけが使えなくなったケースを検出するが、
それとは別に**未入金による強制解約なども含め、ページ自体が完全に無くなった店**（＝解約）
を独立して検出・表示する。予約機能を使っていなかった店の解約も取りこぼさないため、
予約可否とは無関係に全件記録する（`delistedAt`）。判定はgourmet APIの掲載一覧に
含まれなくなったことをもって行うため`<title>`スクレイピングより信頼度が高く、2段階確認は
不要（掲載終了チェックは1日3回・毎回全件走るため）。予約可だった店が解約した場合は、
従来どおり`reservationLostAt`（予約不可）にも計上され、両方のタブに表示される。

判定条件は「今回のgourmet API取得結果に含まれておらず、かつまだ`delistedAt`が
記録されていない店」（前回との単純な差分ではない）。差分方式だと消えた直後の1回しか
検出チャンスが無く、その回に安全弁で中断する等があると永久に見逃してしまうため、
「現在時点でまだ確認できていない」を条件にして取りこぼしを防いでいる。再掲載
（解約から復帰）されると`delistedAt`は自動的に消え、解約リストから外れる。
API取得の一時的な不調で大量の店を誤って解約と判定しないよう、
`newlyDelisted.length > max(20, prevActive * 10%)`の安全弁も別途持つ。

## 検出精度のための仕組み（誤検出対策）

アタックリストは営業が実際に架電する情報源になるため、誤検出（本当は予約できるのに
「不可」と表示してしまう）を防ぐことを最優先にしている。

1. **2段階確認方式**（`applyReservableCheck`）: 予約可→不可への変化を1回のチェックだけで
   確定させない。1回目にfalseを検出した時点では `reservationSuspectedAt`（疑い）を記録する
   だけでアタックリストには載せず、次のローテーションでも連続してfalseだった場合に初めて
   `reservationLostAt`（確定）を記録してアタックリスト入りする。確認の間にtrueへ戻れば
   疑いを解除して確定させない。**掲載自体が終了した店**（掲載有無チェックは毎日走り信頼度が
   高い）は2段階を経ず即確定する。
   - `lastReservableAt`（予約可能を最後に確認した日）〜`reservationSuspectedAt`（1回目検出）
     〜`reservationLostAt`（2回目確認・確定）の3つの日付を記録し、`index.html`/
     `list-reservation-lost.mjs`の両方で「1回目検出」「2回目確認(確定)」として表示する。
     ローテーションのため各日付とも「正確にいつ変わったか」ではなく、幅としてしか特定できない。
2. **title/body二重チェック**（`checkReservable`）: `<title>`タグに「ネット予約可」が
   無い場合でも、本文に実際の予約不可メッセージ（「現在ネット予約を受け付けていません」）が
   無ければ false と決め打ちせず判定不能（null）としてスキップする。HotPepper側のタイトル
   表記仕様が変わった場合などに、単一シグナルへの依存で誤って全店を「予約不可」と
   判定してしまう事故を防ぐ。
3. **異常検知の安全弁**: 1回の実行で新たに「予約不可」を確定した件数が
   `LOST_SURGE_ABS_THRESHOLD`（20件）またはチェック数の10%を超えたら、検出ロジック自体が
   壊れている可能性が高いとみなして台帳を更新せず中断する（`current.size < prevActive * 0.5`
   という既存の台帳取得数チェックと同じ考え方）。
4. **アタックリストに載っている店・疑い中の店は毎回のローテーションで優先的に再チェックする**
   （800件枠の先頭を必ず割り当てる）。優先しないと、①ネット予約が再び使えるようになった店が
   次に選ばれるまで（東京なら最大2週間ほど）アタックリストに載ったままになる、②1回目検出
   （疑い）のまま確認が長期間先延ばしになる、という2つの問題が起きるため。再チェックで
   `reservable: true`が確認できた店は`reservationSuspectedAt`/`reservationLostAt`を削除し、
   アタックリストから自動的に外れる。
5. **手動除外**（`data/manual-overrides.json`）: 上記をすり抜けた誤検出に気付いた場合、
   店舗IDを`excludedIds`に追加すればその店だけを公開用アタックリスト
   （`hotpepper-reservation-lost*.json`/`hotpepper-delisted*.json`両方）から除外できる。
   台帳（`hotpepper-roster*.json`）本体には残るため、後で解除も追跡もできる。

## 重要な設計ルール

- **sinntennとの責務分離を維持する**: 新店収集（Googleニュース・求人ボックス・
  Indeed・簡易HP掲載チェック）は sinntenn 側の役割。このリポジトリは
  「ホットペッパー全掲載店の台帳管理」と「ネット予約不可・解約の検出」に専念する
- 県を追加するとき: `scripts/prefectures.mjs` に県設定を足し、`index.html` の
  `PREFS`、ワークフローの県ループにも同じ県を足す（3箇所）
- 台帳更新は `scripts/test-data.mjs` の監査を通ってからコミットする
  （壊れたJSON・台帳とアタックリストの件数不一致があればコミットしない）

## 開発時の注意

- ローカルにNode/Pythonが無い環境で開発してきた。動作確認は
  **pushしてActionsで実行**するのが確実（`scripts/*.mjs` かワークフローの変更pushで自動実行される）
- 画面の確認は簡易HTTPサーバーで `index.html` を開く（`fetch('./data/...')` があるため
  file:// では動かない）
- ワークフローの流れ: Test data (before) → 台帳更新（4県）→ Test data (after) → Commit。
  監査が失敗すると公開されず、前回のデータが残る（安全側に倒れる）
- コミットメッセージは日本語でよい
