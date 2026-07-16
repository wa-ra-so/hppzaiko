# ホットペッパー在庫 / アタックリスト（千葉・東京・神奈川・埼玉）

食べログ営業のメンバーが使う営業支援ツール。ホットペッパーグルメの掲載店台帳を
1日3回自動更新し、「ネット予約カレンダーが使えなくなった店（＝アタック対象）」を
GitHub Pagesで一覧表示する。**依存パッケージなし**（Node 20+の組み込みfetchのみ）。

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
| `index.html` | ネット予約不可アタックリスト画面（期間・エリア・ジャンル絞り込み、CSV保存）。`data/hotpepper-reservation-lost*.json` を表示。旧 `sinntenn/attack.html` |
| `scripts/prefectures.mjs` | 対象県設定（id/name/short/dataFile）。sinntenn側の同名ファイルとは別物（エリア判定用のaliasesは不要なため簡略版） |
| `scripts/hotpepper-roster.mjs` | ホットペッパー全掲載店の台帳更新＋ネット予約可否チェック（`--pref=`で県指定）。Actionsから1日3回、4県分実行 |
| `scripts/list-reservation-lost.mjs` | 台帳からネット予約不可になった店をCLI出力・CSV書き出しするヘルパー |
| `scripts/test-data.mjs` | `data/*.json` の整合性チェック（JSON構文・スキーマ・台帳とアタックリストの件数一致）。台帳更新の前後でActionsから実行し、壊れたデータをコミットしない |
| `data/hotpepper-roster*.json` | 県ごとのホットペッパー掲載台帳（店舗IDごとの firstSeenAt / lastSeenAt / reservable / reservableCheckedAt / lastReservableAt / reservationLostAt。Actionsが自動コミット） |
| `data/hotpepper-reservation-lost*.json` | 台帳から抽出したネット予約不可店のみの軽量版（`index.html` が読む） |

## データソース・判定ロジック（hotpepper-roster.mjs）

ホットペッパーグルメAPI（`HOTPEPPER_API_KEY` シークレット設定時のみ）で対象県の
全掲載店を取得し、店舗ページ本体を取得して `<title>` タグの「＜ネット予約可＞」
表記の有無でネット予約可否を判定する（グルメサーチAPIにはこのフィールドが無い）。

全店を毎回チェックすると重いため、未チェック・チェックが古い店から1回の実行につき
800件ローテーションで確認（1日3回×800件＝2,400件／日／県。千葉・埼玉は約2〜3日、
神奈川は約4日、店舗数の多い東京は約2週間で一巡）。ネット予約可→不可に変わった店を
検出し、`lastReservableAt`（予約可能を最後に確認した日）と `reservationLostAt`
（不可を検出した日）を記録する。**ローテーションのため「正確にいつ変わったか」は
わからず、この2つの日付の間のどこかとしてしか特定できない**（掲載自体が終了した
場合は台帳の掲載有無チェックが毎日走るため、その部分は1日単位で正確）。

台帳の記録は2026-07-14開始（東京・神奈川・埼玉は2026-07-15開始）で、それ以前には
遡れない。分離後もこの記録は引き継いでいる（sinntennから移行したデータをそのまま
コミット）。

## 重要な設計ルール

- **sinntennとの責務分離を維持する**: 新店収集（Googleニュース・求人ボックス・
  Indeed・簡易HP掲載チェック）は sinntenn 側の役割。このリポジトリは
  「ホットペッパー全掲載店の台帳管理」と「ネット予約不可検出」に専念する
- 県を追加するとき: `scripts/prefectures.mjs` に県設定を足し、`index.html` の
  `PREFS`、ワークフローの県ループにも同じ県を足す（3箇所）
- 台帳更新は `scripts/test-data.mjs` の監査を通ってからコミットする
  （壊れたJSON・台帳とアタックリストの件数不一致があればコミットしない）
- `index.html` の「← 新店リサーチへ」リンクは別リポジトリ（sinntenn）の
  GitHub Pages URLへの外部リンク。相対パスにしない

## 開発時の注意

- ローカルにNode/Pythonが無い環境で開発してきた。動作確認は
  **pushしてActionsで実行**するのが確実（`scripts/*.mjs` かワークフローの変更pushで自動実行される）
- 画面の確認は簡易HTTPサーバーで `index.html` を開く（`fetch('./data/...')` があるため
  file:// では動かない）
- ワークフローの流れ: Test data (before) → 台帳更新（4県）→ Test data (after) → Commit。
  監査が失敗すると公開されず、前回のデータが残る（安全側に倒れる）
- コミットメッセージは日本語でよい
