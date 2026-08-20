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
//
// 必要な環境変数(wrangler.toml の [vars] で設定):
//   GITHUB_OWNER           リポジトリのオーナー名
//   GITHUB_REPO            リポジトリ名

const GITHUB_API = 'https://api.github.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    if (request.method === 'POST' && url.pathname === '/slack/interactions') {
      return handleSlackInteraction(request, env);
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
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
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
  if (!res.ok) throw new Error(`GitHub更新エラー: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- Slackボタン(承認/却下)の処理 ----------

async function handleSlackInteraction(request, env) {
  const rawBody = await request.text();
  const valid = await verifySlackSignature(request, env, rawBody);
  if (!valid) return new Response('invalid signature', { status: 401 });

  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get('payload'));
  const action = payload.actions && payload.actions[0];
  if (!action) return new Response('', { status: 200 });

  const [decision, termId] = action.value.split(':');
  const userName = payload.user ? payload.user.username : 'unknown';

  try {
    const { content: terms, sha } = await getFile(env, 'data/terms.json', 'main');
    const idx = terms.findIndex((t) => t.id === termId);

    if (idx === -1) {
      return respondSlackUpdate(`:warning: ${termId} は既に処理済み、または見つかりませんでした。`);
    }

    let resultText;
    if (decision === 'approve') {
      terms[idx].status = 'published';
      await putFile(env, 'data/terms.json', 'main', terms, sha, `Slack承認: ${termId} を公開(by @${userName})`);
      resultText = `:white_check_mark: *${termId} ${terms[idx].term}* を公開しました(承認: @${userName})`;
    } else if (decision === 'reject') {
      const term = terms[idx].term;
      terms.splice(idx, 1);
      await putFile(env, 'data/terms.json', 'main', terms, sha, `Slack却下: ${termId} を削除(by @${userName})`);
      resultText = `:x: *${termId} ${term}* を却下しました(却下: @${userName})`;
    } else {
      return new Response('', { status: 200 });
    }

    return respondSlackUpdate(resultText);
  } catch (err) {
    return respondSlackUpdate(`:warning: 処理中にエラーが発生しました: ${err.message}`);
  }
}

function respondSlackUpdate(text) {
  // 元のメッセージをこの内容で置き換える(ボタンは消える)
  return jsonResponse({ replace_original: true, text });
}

// ---------- ローカル変更の書き戻し(サイト → PR自動作成) ----------

async function handleSubmitLocalChanges(request, env) {
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
    return jsonResponse({ error: err.message }, 500);
  }
}
