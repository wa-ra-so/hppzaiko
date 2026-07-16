# hppzaiko

ホットペッパーグルメの掲載店台帳を1日3回自動更新し、ネット予約カレンダーが
使えなくなった店（アタック対象）を一覧表示するサイト（千葉・東京・神奈川・埼玉）。

- **公開URL**: https://wa-ra-so.github.io/hppzaiko/ （アタックリスト）
- 姉妹ツール「新店リサーチ」: https://wa-ra-so.github.io/sinntenn/

姉妹リポジトリ [`sinntenn`](https://github.com/wa-ra-so/sinntenn) からアタックリスト
機能のみを分離したもの。**sinntennは新店リサーチのみ、hppzaikoはアタックリストのみ**
を担当し、更新ワークフローを分けることでどちらか一方の負荷がもう一方に影響しない
ようにしている。

## 仕組み

| ファイル | 役割 |
|---|---|
| `index.html` | アタックリストの画面（期間・エリア・ジャンル絞り込み、CSV保存） |
| `scripts/hotpepper-roster.mjs` | ホットペッパーAPIで対象県の全掲載店を取得し、店舗ページの表記からネット予約可否をチェックして `data/hotpepper-roster*.json` を更新 |
| `scripts/list-reservation-lost.mjs` | 台帳からネット予約不可店をCLI表示・CSV出力するヘルパー |
| `scripts/test-data.mjs` | `data/*.json` の整合性チェック（台帳更新の前後でActionsから実行） |
| `.github/workflows/update-attack-list.yml` | 1日3回（6:00/14:00/22:00 JST頃）自動実行（Actionsのcron） |
| `data/hotpepper-roster*.json` | 県ごとの掲載台帳（自動コミット） |
| `data/hotpepper-reservation-lost*.json` | 台帳から抽出したネット予約不可店のみの軽量版（`index.html` が読む） |

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
