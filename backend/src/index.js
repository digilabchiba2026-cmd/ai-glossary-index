// 生成AI用語インデックス: バックエンド(Cloudflare Worker)
//
// 役割:
//   1. POST /slack/interactions
//      Slackの「承認/却下」ボタン押下を受け取り、data/terms.json をGitHub上で直接更新する。
//      (承認 → status を published に、却下 → 該当エントリを削除)
//   2. POST /submit-local-changes
//      閲覧サイトからローカルの追加/編集/削除を受け取り、ブランチを切って
//      data/terms.json を更新し、Pull Request を自動作成する。
//
// 必要なシークレット(`wrangler secret put <NAME>` で設定):
//   GITHUB_TOKEN           対象リポジトリへの書き込み権限を持つトークン(Contents + Pull requests)
//   SLACK_SIGNING_SECRET   Slack Appの Signing Secret(リクエスト検証用)
//   SUBMIT_KEY             /submit-local-changes 用の合言葉(編集者だけが知る値。サイトのコードには書かない)
//   SLACK_BOT_TOKEN        (任意)Slackの返信URLが使えないときの代替手段(メッセージの更新/投稿)に使う
//
// 必要な環境変数(wrangler.toml の [vars] で設定):
//   GITHUB_OWNER           リポジトリのオーナー名
//   GITHUB_REPO            リポジトリ名

const GITHUB_API = 'https://api.github.com';

// 呼び出しを許可する閲覧サイトのオリジン
const ALLOWED_ORIGIN = 'https://ai-glossary-index-site.pages.dev';

// 1回の提出で受け付ける最大件数(大量投入の防止)
const MAX_CHANGES = 50;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    if (request.method === 'POST' && url.pathname === '/slack/interactions') {
      return handleSlackInteraction(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/submit-local-changes') {
      return withCors(await handleSubmitLocalChanges(request, env));
    }

    return new Response('Not found', { status: 404 });
  },
};

// ---------- CORS(閲覧サイトからのブラウザfetchに必要) ----------

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Submit-Key');
  return new Response(response.body, { status: response.status, headers });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------- Slack署名検証 ----------

async function verifySlackSignature(request, env, rawBody) {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  const signature = request.headers.get('X-Slack-Signature');
  if (!timestamp || !signature) return false;

  // リプレイ攻撃対策: 5分以上古いリクエストは拒否
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  const hex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expected = `v0=${hex}`;
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ---------- GitHub Contents API ----------

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'ai-glossary-index-bot',
  };
}

async function getFile(env, path, ref) {
  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${ref}`,
    { headers: githubHeaders(env) }
  );
  if (!res.ok) throw new Error(`GitHub取得エラー: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
  return { content: JSON.parse(content), sha: data.sha };
}

async function putFile(env, path, branch, jsonContent, sha, message) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(jsonContent, null, 2) + '\n'))),
    branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: githubHeaders(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`GitHub更新エラー: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------- Slackボタン(承認/却下)の処理 ----------

async function handleSlackInteraction(request, env, ctx) {
  const rawBody = await request.text();
  const valid = await verifySlackSignature(request, env, rawBody);
  if (!valid) {
    console.log('[slack] invalid signature (SLACK_SIGNING_SECRET が違う可能性)');
    return new Response('invalid signature', { status: 401 });
  }

  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get('payload'));
  const action = payload.actions && payload.actions[0];
  if (!action) return new Response('', { status: 200 });

  // Slackへは3秒以内に200 OKを返す必要があるため、実際の処理は非同期(waitUntil)で行い、
  // 結果はpayload.response_urlへ改めて送信して元のメッセージを更新する。
  ctx.waitUntil(processApproval(payload, action, env));
  return new Response('', { status: 200 });
}

async function processApproval(payload, action, env) {
  const [decision, termId] = action.value.split(':');
  const userName = payload.user ? payload.user.username : 'unknown';
  const responseUrl = payload.response_url;

  let resultText;
  let isError = false;
  try {
    // 複数のボタンを続けて押すと、同時に data/terms.json を更新しようとして
    // GitHubが「古いsha」を理由に拒否する(409/422)。その場合は最新を取り直して数回やり直す。
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { content: terms, sha } = await getFile(env, 'data/terms.json', 'main');
      const idx = terms.findIndex((t) => t.id === termId);

      if (idx === -1) {
        resultText = `:warning: ${termId} は既に処理済み、または見つかりませんでした。`;
        isError = true;
        break;
      }
      if (decision !== 'approve' && decision !== 'reject') return;

      try {
        if (decision === 'approve') {
          terms[idx].status = 'published';
          await putFile(env, 'data/terms.json', 'main', terms, sha, `Slack承認: ${termId} を公開(by @${userName})`);
          resultText = `:white_check_mark: *${termId} ${terms[idx].term}* を公開しました(承認: @${userName})`;
        } else {
          const term = terms[idx].term;
          terms.splice(idx, 1);
          await putFile(env, 'data/terms.json', 'main', terms, sha, `Slack却下: ${termId} を削除(by @${userName})`);
          resultText = `:x: *${termId} ${term}* を却下しました(却下: @${userName})`;
        }
        break;
      } catch (putErr) {
        const conflict = putErr.status === 409 || putErr.status === 422;
        if (!conflict || attempt === MAX_ATTEMPTS) throw putErr;
        // 他のボタン処理と衝突した。少し待って最新を取り直す(待ち時間をずらして再衝突を避ける)
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 700 * attempt));
      }
    }
  } catch (err) {
    resultText = `:warning: 処理中にエラーが発生しました: ${err.message}`;
    isError = true;
  }

  console.log(`[approval] ${decision}:${termId} by @${userName} -> ${isError ? 'ERROR' : 'OK'} ${resultText}`);
  await notifySlack(payload, env, resultText, isError);
}

// 結果をSlackに知らせる。
// 成功時: 元のメッセージ(ボタン付き)を結果で置き換える。
// エラー時: 元のメッセージとボタンは残し、エラーは別メッセージとして投稿する(再試行できるように)。
// response_url は発行から30分(最大5回)しか使えないため、失敗したら Bot Token での更新/投稿に切り替える。
async function notifySlack(payload, env, resultText, isError) {
  const errorText = `${resultText}\n(上の承認/却下ボタンは残してあります。原因を直した後、もう一度押してください)`;

  if (payload.response_url) {
    try {
      const body = isError
        ? { replace_original: false, response_type: 'in_channel', text: errorText }
        : { replace_original: true, text: resultText };
      const res = await fetch(payload.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      console.log(`[notify] response_url failed: ${res.status} ${await res.text()}`);
    } catch (e) {
      console.log(`[notify] response_url exception: ${e.message}`);
    }
  }

  // フォールバック(任意): wrangler secret put SLACK_BOT_TOKEN を設定していれば使う
  if (!env.SLACK_BOT_TOKEN || !payload.channel || !payload.message) {
    console.log('[notify] no fallback available (SLACK_BOT_TOKEN not set)');
    return;
  }
  const channel = payload.channel.id;
  const ts = payload.message.ts;
  try {
    const api = isError ? 'chat.postMessage' : 'chat.update';
    const body = isError
      ? { channel, thread_ts: ts, text: errorText }
      : { channel, ts, text: resultText, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: resultText } }] };
    const res = await fetch(`https://slack.com/api/${api}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify(body),
    });
    console.log(`[notify] fallback ${api}: ${await res.text()}`);
  } catch (e) {
    console.log(`[notify] fallback exception: ${e.message}`);
  }
}

// ---------- ローカル変更の書き戻し(サイト → PR自動作成) ----------

async function handleSubmitLocalChanges(request, env) {
  // 合言葉の確認(未設定のときは安全側に倒して全拒否)
  const providedKey = request.headers.get('X-Submit-Key') || '';
  if (!env.SUBMIT_KEY || !timingSafeEqual(providedKey, env.SUBMIT_KEY)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid json' }, 400);
  }

  const added = payload.added || [];
  const edited = payload.edited || [];
  const deletedIds = payload.deletedIds || [];

  if (added.length === 0 && edited.length === 0 && deletedIds.length === 0) {
    return jsonResponse({ error: '変更がありません' }, 400);
  }
  if (!Array.isArray(added) || !Array.isArray(edited) || !Array.isArray(deletedIds) ||
      added.length + edited.length + deletedIds.length > MAX_CHANGES) {
    return jsonResponse({ error: `変更は1回につき${MAX_CHANGES}件までです` }, 400);
  }

  try {
    const branch = `auto/local-changes-${Date.now()}`;

    const mainRefRes = await fetch(
      `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/ref/heads/main`,
      { headers: githubHeaders(env) }
    );
    const mainRef = await mainRefRes.json();

    await fetch(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/refs`, {
      method: 'POST',
      headers: githubHeaders(env),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainRef.object.sha }),
    });

    const { content: terms, sha } = await getFile(env, 'data/terms.json', branch);
    let working = [...terms];

    added.forEach((t) => working.push({ ...t, status: 'draft' }));
    edited.forEach((e) => {
      const idx = working.findIndex((t) => t.id === e.id);
      if (idx !== -1) working[idx] = { ...working[idx], ...e };
    });
    working = working.filter((t) => !deletedIds.includes(t.id));

    await putFile(env, 'data/terms.json', branch, working, sha, 'サイトからのローカル変更を反映(要レビュー)');

    const prRes = await fetch(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/pulls`, {
      method: 'POST',
      headers: githubHeaders(env),
      body: JSON.stringify({
        title: `[サイトから提出] ローカルの変更(${added.length + edited.length + deletedIds.length}件)`,
        head: branch,
        base: 'main',
        body: 'ブラウザの閲覧サイトから提出されたローカルの変更です。内容を確認してマージしてください。',
      }),
    });
    const pr = await prRes.json();

    return jsonResponse({ pull_request_url: pr.html_url });
  } catch (err) {
    console.error(err); // 詳細はCloudflareのログにのみ残し、外部には返さない
    return jsonResponse({ error: '処理中にエラーが発生しました' }, 500);
  }
}