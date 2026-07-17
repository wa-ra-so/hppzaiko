# hppzaiko

ホットペッパーグルメの掲載店台帳を1日6回自動更新し、「ネット予約カレンダーが
使えなくなった店」「解約（掲載自体が終了した店）」の2種類のアタック対象を
一覧表示するサイト（千葉・東京・神奈川・埼玉）。

- **公開URL**: https://wa-ra-so.github.io/hppzaiko/ （アタックリスト）
- 姉妹ツール「新店リサーチ」: https://wa-ra-so.github.io/sinntenn/

姉妹リポジトリ [`sinntenn`](https://github.com/wa-ra-so/sinntenn) からアタックリスト
機能のみを分離したもの。**sinntennは新店リサーチのみ、hppzaikoはアタックリストのみ**
を担当し、更新ワークフローを分けることでどちらか一方の負荷がもう一方に影響しない
ようにしている。

## 仕組み

| ファイル | 役割 |
|---|---|
| `index.html` | アタックリストの画面。「予約不可」「解約（掲載終了）」の2タブ（期間・エリア・ジャンル絞り込み、CSV保存） |
| `scripts/hotpepper-roster.mjs` | ホットペッパーAPIで対象県の全掲載店を取得し、店舗ページの表記からネット予約可否をチェック＋掲載終了（解約）を検出して `data/hotpepper-roster*.json` を更新 |
| `scripts/list-reservation-lost.mjs` | 台帳からネット予約不可店をCLI表示・CSV出力するヘルパー |
| `scripts/list-delisted.mjs` | 台帳から解約（掲載終了）店をCLI表示・CSV出力するヘルパー |
| `scripts/test-data.mjs` | `data/*.json` の整合性チェック（台帳更新の前後でActionsから実行） |
| `.github/workflows/update-attack-list.yml` | 1日6回自動実行（Actionsのcron。実際の実行時刻はActions側の混雑状況でずれることがある） |
| `data/hotpepper-roster*.json` | 県ごとの掲載台帳（自動コミット） |
| `data/hotpepper-reservation-lost*.json` | 台帳から抽出したネット予約不可店（確定分）のみの軽量版（`index.html` が読む） |
| `data/hotpepper-delisted*.json` | 台帳から抽出した解約（掲載終了）店のみの軽量版（`index.html` が読む） |
| `data/manual-overrides.json` | 誤検出を手動でアタックリストから除外するための店舗IDリスト |

## 検出精度について

営業が実際に架電する情報源のため、誤検出を防ぐ仕組みを入れている（詳細は `CLAUDE.md`）。

- **2段階確認**（予約不可のみ）：予約可→不可への変化は1回のチェックでは確定させず、次の
  ローテーションでも連続してfalseだった場合にのみアタックリストへ確定掲載する
  （1回目＝疑い、2回目＝確定）。各店の行に「1回目検出」「2回目確認(確定)」の日付を表示している
- **解約（掲載終了）検出**：予約可否を問わず、ページ自体が無くなった店を全件検出する。
  gourmet APIの掲載一覧を根拠にするため2段階確認は不要（毎日チェックが走り信頼度が高い）。
  ただし観測期間（初掲載確認〜最終掲載確認）が48時間未満の店は対象外にしている。
  新規開店直後の店は正式オープン前のページ変動で一時的に掲載が消えて見えることがあり、
  これを解約と誤判定しないため
- 万一誤検出が見つかった場合は `data/manual-overrides.json` の `excludedIds` に
  店舗ID（例: `J004492214`）を追加すれば、その店だけをアタックリスト表示から除外できる

## ホットペッパーAPIキーの設定

1. [リクルートWebサービス](https://webservice.recruit.co.jp/) でAPIキーを無料発行（メール登録のみ）
2. このリポジトリの **Settings → Secrets and variables → Actions → New repository secret** で
   - Name: `HOTPEPPER_API_KEY`
   - Secret: 発行されたキー
3. 次回の自動実行（またはActionsから手動実行）以降、台帳が更新されます

キー未設定の間は台帳更新がスキップされ、既存のデータがそのまま表示されます。

## メンテナンス

- **県を追加する**ときは `scripts/prefectures.mjs` に県設定を足し、`index.html` の
  `PREFS` とワークフローの県ループにも同じ県を足す
- **データ監査**：`scripts/test-data.mjs` が台帳更新の前後で `data/*.json` の
  構文・スキーマ・件数整合性をチェックし、不整合が1件でもあれば公開前に失敗して止まる
- 台帳の記録は2026-07-14開始（東京・神奈川・埼玉は2026-07-15開始）で、それ以前には
  遡れない。ローテーションチェックのため「予約できなくなった正確な日」は特定できず、
  `lastReservableAt`〜`reservationLostAt` の間として記録される
