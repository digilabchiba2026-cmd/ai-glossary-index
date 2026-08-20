# 生成AI用語インデックス — 定期無人収集 & 承認の完全自動化

Phase 4「定期無人実行」を、Slackのボタン操作で承認・却下まで完結する形で実現する仕組みです。
3つの部分で構成されます。

```
[GitHub Actions]                [Cloudflare Worker(backend/)]         [閲覧サイト]
毎週月曜 自動実行                  Slackボタン押下を受けて                起動時にGitHubの
 → 新語候補をWeb検索               data/terms.json を直接更新             data/terms.json
 → 重複除外・信頼度判定             (承認→published / 却下→削除)          (published のみ)
 → data/terms.json に                                                  を取得して表示
   draftとして直接コミット        ローカル編集の書き戻しも担当
 → Slackに承認/却下ボタン付き       (サイト → ブランチ作成 → PR自動作成)
   メッセージを投稿
        ↓
     チームがSlackで
     ボタンをクリック
```

## ファイル構成
```
.github/workflows/collect-terms.yml   … 週次cronワークフロー本体
scripts/collect-candidates.mjs        … 候補収集ロジック(Node.js)。terms.jsonにdraftとして直接コミット
data/terms.json                       … 語句データベース(現行25語句。すべてstatus: "published")
backend/                              … Cloudflare Worker(Slackボタン処理・ローカル変更のPR自動作成)
  src/index.js
  wrangler.toml
  package.json
```

## 導入手順

### 1. リポジトリの準備
このディレクトリの中身を、対象のGitHubリポジトリのルートに配置し、公開(public)リポジトリとして作成する。
- 閲覧サイトはブラウザから `raw.githubusercontent.com` に直接フェッチするため、プライベートリポジトリの場合は別途認証つきの取得経路が必要。

### 2. GitHub側の設定
Settings → Secrets and variables → Actions で以下を登録する。
- `ANTHROPIC_API_KEY` … Claude APIキー(Web検索付きの候補収集に使用)
- `SLACK_BOT_TOKEN` … 後述のSlack AppのBot User OAuth Token(`xoxb-...`)
- `SLACK_CHANNEL_ID` … 投稿先チャンネル(`#proj-self-expanding-index`)のチャンネルID

`.github/workflows/collect-terms.yml` の `cron` はUTC指定。デフォルトは毎週月曜09:00 JST。

### 3. バックエンド(Cloudflare Worker)のデプロイ
```
cd backend
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN          # 対象repoへの書き込み権限を持つPAT(Contents + Pull requests)
npx wrangler secret put SLACK_SIGNING_SECRET  # 後述のSlack Appから取得
npx wrangler deploy
```
`wrangler.toml` の `GITHUB_OWNER` / `GITHUB_REPO` を実際の値に書き換えてからデプロイする。
デプロイ後に払い出される `https://xxxxx.workers.dev` を控えておく。

### 4. Slack Appの作成(初回のみ・手動)
1. https://api.slack.com/apps で新規Appを作成し、対象ワークスペースにインストールする。
2. **OAuth & Permissions** で Bot Token Scopes に `chat:write` を追加し、インストール後の Bot User OAuth Token(`xoxb-...`)を GitHub Secrets の `SLACK_BOT_TOKEN` に設定する。
3. **Interactivity & Shortcuts** を ON にし、Request URL に `https://xxxxx.workers.dev/slack/interactions`(手順3で控えたWorkerのURL)を設定する。
4. **Basic Information** の Signing Secret を控え、`wrangler secret put SLACK_SIGNING_SECRET` で設定する(手順3で実施済みならOK)。
5. Bot を対象チャンネル(`#proj-self-expanding-index`)に招待する(`/invite @botname`)。

### 5. 閲覧サイト側の設定
`ai-glossary-index.jsx` の以下2つの定数を、実際の値に書き換える。
- `GITHUB_RAW_URL` … 例: `https://raw.githubusercontent.com/your-org/ai-glossary-index/main/data/terms.json`
- `BACKEND_URL` … 手順3で控えたWorkerのURL(例: `https://ai-glossary-index-backend.your-subdomain.workers.dev`)

## 運用フロー

**自動収集された候補の承認**
1. 毎週月曜、候補が `data/terms.json` に `status: "draft"` として直接コミットされる(draftはサイトには表示されない)。
2. 各候補がSlackに「承認」「却下」ボタン付きで投稿される。
3. ボタンを押すと、Cloudflare Workerがその場で `data/terms.json` を更新する(承認→`published`に変更、却下→エントリ削除)。人手によるPRレビューは不要。

**ローカルでの手動編集の反映**
1. 閲覧サイト上で追加・編集・削除を行うと、フッターに提出ボタンが表示される。
2. 「ローカルの変更をPRとして自動提出」を押すと、Workerがブランチを作成して `data/terms.json` を更新し、Pull Requestを自動作成する(内容はレビュー後に手動マージ)。
3. バックエンドが未接続、またはエラーの場合は、GitHub Issueとして手動提出するリンクにフォールバックする。

## セキュリティ上の注意
- GitHubへの書き込みトークン(`GITHUB_TOKEN`)は、必ずCloudflare Workerのシークレットとしてのみ保持し、閲覧サイト(ブラウザ側のコード)には一切含めないこと。
- `/slack/interactions` はSlackの署名検証(Signing Secret + タイムスタンプ)を行い、Slackからの正当なリクエストのみを受け付ける。
- `/submit-local-changes` は現状、送信元を制限していない(誰でもPRを作成できる)。閲覧サイトのURLを不特定多数に公開する場合は、簡易的なAPIキー等の追加認証を検討すること。

## 今後の接続ポイント(未着手)
- `/submit-local-changes` エンドポイントの認証強化。
- Slack承認時に、元のSlackメッセージのスレッドや別チャンネルへの詳細ログ記録。
