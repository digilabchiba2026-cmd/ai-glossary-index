// 生成AI用語インデックス: 定期無人実行される候補収集スクリプト
//
// GitHub Actions の cron から実行される想定。
// 1. data/terms.json を読み込み(既存語句。status: "published" or "draft")
// 2. Anthropic API(Web検索ツール付き)で新語候補を検索
// 3. 重複チェック・信頼度スコアリングを行い、新規候補を status: "draft" として
//    data/terms.json に直接追記し、mainブランチにコミットする
//    (draftはサイト上には表示されないため、直接コミットしても閲覧サイトへの影響はない)
// 4. 後続のワークフローステップが、各候補をSlackに「承認/却下」ボタン付きで投稿する
//    (ボタン押下時の処理は backend/ のCloudflare Workerが担当する)
//
// 必要な環境変数:
//   ANTHROPIC_API_KEY  Anthropic API キー(GitHub Actions の Secrets に設定)

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TERMS_PATH = path.join(ROOT, 'data', 'terms.json');

const CATEGORIES = [
  { code: 'ARC', name: 'モデル構造・基盤技術' },
  { code: 'RAG', name: '検索・ナレッジ拡張' },
  { code: 'AGT', name: 'エージェント & 応用システム' },
  { code: 'PMT', name: 'プロンプト & 制御技術' },
  { code: 'GOV', name: 'ガバナンス・評価・リスク' },
];

function normalizeTerm(s) {
  return (s || '').toLowerCase().replace(/[\s\-_/()]/g, '');
}

function isDuplicateTerm(term, existingTerms) {
  const n = normalizeTerm(term);
  if (!n) return false;
  return existingTerms.some((t) => {
    const en = normalizeTerm(t.term);
    return en === n || en.includes(n) || n.includes(en);
  });
}

function scoreConfidence(c) {
  let score = 0;
  if (c.source_url) score += 1;
  if (c.definition && c.definition.length >= 20) score += 1;
  return score >= 2 ? 'high' : 'low';
}

function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('モデルの応答からJSON配列を抽出できませんでした: ' + text.slice(0, 300));
  }
  return text.slice(start, end + 1);
}

function nextId(existingTerms, categoryCode) {
  const count = existingTerms.filter((t) => t.category === categoryCode).length;
  return `${categoryCode}-${String(count + 1).padStart(2, '0')}`;
}

async function loadTerms() {
  const raw = await fs.readFile(TERMS_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function saveTerms(terms) {
  await fs.writeFile(TERMS_PATH, JSON.stringify(terms, null, 2) + '\n', 'utf-8');
}

async function callAnthropic(existingTerms) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('環境変数 ANTHROPIC_API_KEY が設定されていません。');
  }

  const existingNames = existingTerms.map((t) => t.term).join('、');
  const promptText = `あなたは生成AI関連の専門用語を収集するリサーチアシスタントです。

以下はすでにインデックス化済みの語句です(これらと重複させないこと):
${existingNames}

Web検索を使って、上記に含まれない、直近半年程度で使われるようになった生成AI関連の新しい専門用語を3件見つけてください。
各語句について、次の5カテゴリのいずれかに分類してください。
- ARC: モデル構造・基盤技術
- RAG: 検索・ナレッジ拡張
- AGT: エージェント & 応用システム
- PMT: プロンプト & 制御技術
- GOV: ガバナンス・評価・リスク

出力は前置きや説明、コードフェンスを一切含めず、次の形式のJSON配列のみを返してください。
[{"term":"英語表記の用語","category":"ARC","definition":"日本語で1〜2文の定義","source_url":"出典URL","source_note":"出典サイト名"}]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system:
        'あなたは正確で簡潔なJSONのみを出力するリサーチアシスタントです。説明文やMarkdownのコードフェンスは一切出力しないでください。',
      messages: [{ role: 'user', content: promptText }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API エラー: ${res.status} ${body}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const jsonStr = extractJsonArray(textBlocks);
  return JSON.parse(jsonStr);
}

async function main() {
  const terms = await loadTerms();
  const parsed = await callAnthropic(terms);

  const valid = parsed.filter(
    (c) => c && c.term && c.definition && CATEGORIES.some((cat) => cat.code === c.category)
  );
  // 品質担保フロー: 既存語句(status問わず)との重複を自動除外し、信頼度をスコアリング
  const nonDup = valid.filter((c) => !isDuplicateTerm(c.term, terms));

  if (nonDup.length === 0) {
    console.log('新しい候補は見つかりませんでした(重複除外後)。');
    if (process.env.GITHUB_OUTPUT) {
      await fs.appendFile(process.env.GITHUB_OUTPUT, 'count=0\n');
    }
    return;
  }

  // terms.json に status: "draft" として直接追記する。
  // レビューではこの行の status を "published" に書き換えるか、行ごと削除してからマージする。
  const working = [...terms];
  const added = [];
  for (const c of nonDup) {
    const entry = {
      id: nextId(working, c.category),
      category: c.category,
      term: c.term,
      definition: c.definition,
      source_url: c.source_url || null,
      source_note: c.source_note || null,
      confidence: scoreConfidence(c),
      status: 'draft',
      collected_at: new Date().toISOString(),
    };
    working.push(entry);
    added.push(entry);
  }

  await saveTerms(working);
  console.log(`${added.length}件の候補を data/terms.json に draft として追記しました。`);

  const summary = added
    .map((c) => `- [${c.confidence === 'high' ? '信頼度高' : '要確認'}] ${c.id} ${c.term} (${c.category})`)
    .join('\n');

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `count=${added.length}\n`);
    const delimiter = 'EOF_SUMMARY';
    await fs.appendFile(process.env.GITHUB_OUTPUT, `summary<<${delimiter}\n${summary}\n${delimiter}\n`);
    const compact = JSON.stringify(
      added.map((c) => ({ id: c.id, term: c.term, category: c.category, confidence: c.confidence, definition: c.definition }))
    );
    await fs.appendFile(process.env.GITHUB_OUTPUT, `candidates_json=${compact}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
