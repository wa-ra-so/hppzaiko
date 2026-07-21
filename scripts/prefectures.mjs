// 対象都県の設定。scripts/hotpepper-roster.mjs / list-reservation-lost.mjs から参照される。
// 新店リサーチ側（sinntenn）の scripts/prefectures.mjs とは別ファイル
// （こちらはホットペッパー台帳のためエリア判定用の areas/aliases は不要）。
// 県を追加するときはここに1件足し、update-attack-list.yml の県ループにも追加する。

export const DEFAULT_PREF_ID = 'chiba';

// slackWebhookEnv: この県の新規検出をSlack通知する際に読む環境変数名（Incoming Webhook URL）。
// エリア担当者ごとに通知先チャンネルを分けられるよう県ごとに別の変数名にしている。
// 対応するGitHub Secretsが未設定の場合は通知をスキップする（hotpepper-roster.mjs参照）。
export const PREFECTURES = {
  chiba: {
    id: 'chiba',
    name: '千葉県',
    short: '千葉',
    dataFile: 'stores.json', // 従来URL互換のためファイル名は据え置き（hotpepper-roster.jsonに変換される）
    slackWebhookEnv: 'SLACK_WEBHOOK_CHIBA',
  },
  tokyo: {
    id: 'tokyo',
    name: '東京都',
    short: '東京',
    dataFile: 'stores-tokyo.json',
    slackWebhookEnv: 'SLACK_WEBHOOK_TOKYO',
  },
  kanagawa: {
    id: 'kanagawa',
    name: '神奈川県',
    short: '神奈川',
    dataFile: 'stores-kanagawa.json',
    slackWebhookEnv: 'SLACK_WEBHOOK_KANAGAWA',
  },
  saitama: {
    id: 'saitama',
    name: '埼玉県',
    short: '埼玉',
    dataFile: 'stores-saitama.json',
    slackWebhookEnv: 'SLACK_WEBHOOK_SAITAMA',
  },
};

export function getPrefFromArgv(argv = process.argv) {
  const arg = argv.find(a => a.startsWith('--pref='));
  const id = arg ? arg.slice('--pref='.length) : DEFAULT_PREF_ID;
  const pref = PREFECTURES[id];
  if (!pref) {
    throw new Error(`未知の県ID: ${id}（有効: ${Object.keys(PREFECTURES).join(', ')}）`);
  }
  return pref;
}
