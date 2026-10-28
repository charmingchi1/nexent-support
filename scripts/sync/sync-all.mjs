#!/usr/bin/env node
/**
 * Nexent 支撑资源每日同步（只读，不做任何飞书写操作）
 *
 * 同步内容：
 *   push  — 本地待推送队列（tmp_base/pending/，由 table-write.mjs 双确认后入队）→ 批量写飞书（先推后拉）
 *   git   — nexent 仓 develop 分支 fetch + pull --ff-only
 *   faq   — 飞书 wiki FAQ 文档 → 本地复刻 md（保护文件末尾「本地沉淀区」）
 *   base  — 项目管理一张表 6 张表 → tmp_base/*.ndjson（含 manifest/fields）
 *   sheet — 现网问题个人跟踪电子表格（自动发现全部子表）→ tmp_base/*.csv
 *
 * 状态落盘 scripts/sync/state/sync-state.json，并生成 tmp_base/资源索引.md。
 * 用法：node sync-all.mjs [--only push|git|faq|base|sheet]（逗号分隔可多选）[--push-dry-run 只打印将推送内容，不写飞书]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(SCRIPT_DIR, '..', '..');
const STATE_DIR = path.join(SCRIPT_DIR, 'state');
const INDEX_PATH = path.join(WORKSPACE, 'tmp_base', '资源索引.md');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'sync-config.json'), 'utf8'));
const PENDING_DIR = path.join(WORKSPACE, 'tmp_base', 'pending');
const PUSH_DRY = process.argv.includes('--push-dry-run');

const SEDIMENT_MARKER = '<!-- ===== 本地沉淀区（同步保留，勿删） ===== -->';
const SEDIMENT_NOTE = '<!-- 说明：此标记以下内容由本地沉淀（支撑流程⑦闭环）追加；每日同步只更新标记以上的远端内容，此区域原样保留。若某条沉淀已推回飞书 wiki，请从下方删除对应条目。 -->';

// ---------- 基础工具 ----------
const pad = (n) => String(n).padStart(2, '0');
const nowTs = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ymd = () => nowTs().slice(0, 10).replace(/-/g, '');

function atomicWrite(absPath, content) {
  const tmp = `${absPath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, absPath);
}

function parseEnvelope(out) {
  try {
    const j = JSON.parse(out);
    return j.ok === true ? j : null;
  } catch {
    return null;
  }
}

// lark-cli 是 npm 全局包，Windows 下必须用 node 直调其入口（spawn .cmd 会被新版权限策略拒绝）
function resolveLarkEntry() {
  if (process.env.LARK_CLI_ENTRY) return process.env.LARK_CLI_ENTRY;
  if (CONFIG.lark_cli_entry && fs.existsSync(CONFIG.lark_cli_entry)) return CONFIG.lark_cli_entry;
  const cand = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
  if (fs.existsSync(cand)) return cand;
  return process.platform === 'win32' ? null : 'lark-cli'; // unix 直接用 PATH 上的可执行
}
const LARK_ENTRY = resolveLarkEntry();

function lark(args, timeoutMs = 120000) {
  if (LARK_ENTRY === null) throw new Error('找不到 lark-cli 入口，请设置环境变量 LARK_CLI_ENTRY 或配置 sync-config.json 的 lark_cli_entry');
  const entryArgs = LARK_ENTRY.endsWith('.js') ? [LARK_ENTRY, ...args] : args;
  const cmd = LARK_ENTRY.endsWith('.js') ? process.execPath : 'lark-cli';
  return spawnSync(cmd, entryArgs, { encoding: 'utf8', cwd: WORKSPACE, timeout: timeoutMs, windowsHide: true });
}

// ---------- 状态与日志 ----------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'sync-state.json'), 'utf8'));
  } catch {
    return { last_run: null, auth: null, resources: {} };
  }
}
const state = loadState();

const logFile = path.join(STATE_DIR, `sync-${ymd()}.log`);
function log(msg) {
  const line = `[${nowTs()}] ${msg}`;
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* 日志失败不阻断同步 */ }
  console.log(msg);
}

function initResource(key, meta) {
  const prev = state.resources[key] || {};
  state.resources[key] = {
    ...meta,
    status: 'running',
    last_attempt: nowTs(),
    last_ok: prev.last_ok || null,
    detail: prev.detail || {},
    error: null,
  };
  return state.resources[key];
}

// ---------- 各资源同步 ----------
function checkAuth() {
  const r = lark(['auth', 'status', '--json', '--verify'], 60000);
  let ok = false;
  let msg = '';
  if (r.status === 0) {
    try {
      const j = JSON.parse(r.stdout);
      const user = j.identities && j.identities.user;
      // 「needs refresh + 下次 API 调用自动刷新」视为可用：真正的 API 调用会触发自动刷新
      const autoRefresh = /refreshed automatically/i.test(`${user?.note || ''} ${j.note || ''}`);
      ok = !!(user && user.verified !== false && (user.status === 'ready' || autoRefresh));
      msg = (user && user.message) || j.note || '';
    } catch { /* 落入下方失败分支 */ }
  }
  return { ok, msg: ok ? (msg || 'user 身份有效') : `auth 校验失败：${((r.stderr || r.stdout || r.error?.message || '').trim().slice(-200))}` };
}

function syncGit(st) {
  const g = CONFIG.git;
  const git = (args, timeout = 180000) =>
    spawnSync('git', ['-C', g.repo, ...args], { encoding: 'utf8', timeout, windowsHide: true });
  const gd = (r) => (r.stdout || '').trim();

  const branch = gd(git(['rev-parse', '--abbrev-ref', 'HEAD']));
  const dirty = gd(git(['status', '--porcelain'])).split('\n').filter(Boolean).length;
  git(['rev-parse', 'HEAD']);

  const fr = git(['fetch', g.remote, '--prune']);
  if (fr.status !== 0) {
    st.status = 'failed';
    st.error = `git fetch 失败：${(fr.stderr || fr.error?.message || '').trim().slice(-300)}`;
    return;
  }
  const behind = parseInt(gd(git(['rev-list', '--count', `HEAD..${g.remote}/${g.branch}`])) || '0', 10);
  const ahead = parseInt(gd(git(['rev-list', '--count', `${g.remote}/${g.branch}..HEAD`])) || '0', 10);

  let pulled = 0;
  if (behind > 0) {
    const pr = git(['pull', '--ff-only', g.remote, g.branch]);
    if (pr.status !== 0) {
      st.status = 'diverged';
      st.error = `本地无法 fast-forward（领先 ${ahead} 提交 / 未提交改动 ${dirty} 个），需人工处理：${(pr.stderr || '').trim().slice(-300)}`;
      return;
    }
    pulled = behind;
  }
  const head = gd(git(['rev-parse', 'HEAD']));
  const subject = gd(git(['log', '-1', '--format=%s']));
  st.status = 'ok';
  st.last_ok = nowTs();
  st.detail = { branch, head: head.slice(0, 9), subject, behind_before: behind, ahead, dirty_files: dirty, pulled };
}

function replaceFigures(md) {
  // 附件卡片 → 占位说明（保留文件名/大小/token，二进制不下载）
  return md.replace(/<figure[^>]*view-type="Card"[^>]*>([\s\S]*?)<\/figure>/g, (m, inner) => {
    const name = (inner.match(/name="([^"]*)"/) || [])[1] || 'attachment';
    const size = parseInt((inner.match(/size="(\d+)"/) || [])[1] || '0', 10);
    const token = (inner.match(/token="([^"]*)"/) || [])[1] || '';
    const mb = size ? `约 ${Math.max(1, Math.round(size / 1024 / 1024))} MB，` : '';
    return `> 📎 **附件**：\`${name}\`（${mb}飞书附件 token：\`${token}\`，请从原文档下载）`;
  });
}

function syncFaq(st) {
  const f = CONFIG.faq;
  const r = lark(['docs', '+fetch', '--doc', f.doc_id, '--doc-format', 'markdown', '--scope', 'full', '--as', 'user'], 180000);
  const env = r.status === 0 ? parseEnvelope(r.stdout) : null;
  if (!env || !env.data || !env.data.document) {
    st.status = 'failed';
    st.error = `docs +fetch 失败：${((r.stderr || r.stdout || r.error?.message || '').trim().slice(-300))}`;
    return;
  }
  const doc = env.data.document;
  const outPath = path.join(WORKSPACE, f.output);

  // 沉淀区保护：标记以下内容原样保留
  let sediment = '';
  if (fs.existsSync(outPath)) {
    const cur = fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n');
    const idx = cur.indexOf(SEDIMENT_MARKER);
    if (idx >= 0) sediment = cur.slice(idx).trimEnd() + '\n';
  }
  if (!sediment) sediment = `${SEDIMENT_MARKER}\n${SEDIMENT_NOTE}\n`;

  const header = [
    '<!-- 复刻自飞书 wiki 文档 · 由 scripts/sync/sync-all.mjs 自动同步；标记以上内容勿手工编辑，本地沉淀条目写在文件末尾标记以下 -->',
    `<!-- 原文：${f.wiki_url} -->`,
    `<!-- doc_id: ${f.doc_id} ｜ 同步时间：${nowTs()} ｜ revision: ${doc.revision_id} -->`,
    '<!-- 二进制附件以占位说明保留，请从原文档获取 -->',
  ].join('\n');
  const body = replaceFigures(doc.content || '').replace(/\r\n/g, '\n').trim();
  const out = `${header}\n\n${body}\n\n${sediment}`;
  atomicWrite(outPath, out);

  const headings = sediment.match(/^## .*/gm);
  st.status = 'ok';
  st.last_ok = nowTs();
  st.detail = {
    revision: doc.revision_id,
    bytes: Buffer.byteLength(out),
    sediment_entries: headings ? headings.length : 0,
    sediment_bytes: Buffer.byteLength(sediment),
  };
}

function syncBaseTable(st, t) {
  const b = CONFIG.base;
  const r = lark([
    'base', '+record-list', '--as', 'user',
    '--base-token', b.base_token, '--table-id', t.table_id,
    '--format', 'ndjson', '--output', t.output, '--overwrite',
  ], 300000);
  const manifest = r.status === 0 ? JSON.parse(r.stdout || '{}') : null;
  if (!manifest || manifest.rev === undefined) {
    st.status = 'failed';
    st.error = `record-list 失败：${((r.stderr || r.stdout || r.error?.message || '').trim().slice(-300))}`;
    return;
  }
  // 字段定义快照（现有 fields_*.json 同款格式）
  const rf = lark(['base', '+field-list', '--as', 'user', '--base-token', b.base_token, '--table-id', t.table_id], 120000);
  let fieldsOk = false;
  if (rf.status === 0 && parseEnvelope(rf.stdout)) {
    atomicWrite(path.join(WORKSPACE, 'tmp_base', `fields_${t.table_id}.json`), rf.stdout);
    fieldsOk = true;
  }
  st.status = 'ok';
  st.last_ok = nowTs();
  st.detail = {
    rev: manifest.rev,
    records: manifest.records_count,
    has_more: manifest.has_more === true,
    fields_refreshed: fieldsOk,
  };
}

function syncSheet(st, wbMeta, s) {
  const cfg = CONFIG.sheet;
  const tmpJson = 'tmp_base/_csv_tmp.json';
  const tmpAbs = path.join(WORKSPACE, tmpJson);
  try {
    const r = lark([
      'sheets', '+csv-get', '--as', 'user',
      '--spreadsheet-token', cfg.spreadsheet_token,
      '--sheet-id', s.sheet_id, '--include-row-prefix=false', '--format', 'csv',
      '--output-path', tmpJson,
    ], 180000);
    if (r.status !== 0) {
      st.status = 'failed';
      st.error = `csv-get 失败：${((r.stderr || r.stdout || r.error?.message || '').trim().slice(-300))}`;
      return;
    }
    const payload = JSON.parse(fs.readFileSync(tmpAbs, 'utf8'));
    const data = payload.data || payload;
    let csv = data.annotated_csv ?? data.csv ?? '';
    if (data.has_more === true) {
      st.status = 'failed';
      st.error = '导出被截断（has_more=true），数据超过单次导出上限，需人工扩容 --max-chars';
      return;
    }
    // 去掉每行前导空格与文末空行，统一结尾换行
    csv = csv.split('\n').map((l) => l.replace(/^ +/, '')).join('\n').replace(/\n{3,}$/, '\n').trimEnd() + '\n';
    const file = path.join(WORKSPACE, cfg.output_dir, `${cfg.output_prefix}_${s.sheet_name}.csv`);
    atomicWrite(file, csv);
    st.status = 'ok';
    st.last_ok = nowTs();
    st.detail = {
      workbook_rev: wbMeta.revision,
      rows: data.row_count ?? null,
      cols: data.col_count ?? null,
      actual_range: data.actual_range ?? null,
      file: `${cfg.output_dir}/${cfg.output_prefix}_${s.sheet_name}.csv`,
    };
  } finally {
    try { fs.rmSync(tmpAbs, { force: true }); } catch { /* 忽略清理失败 */ }
  }
}

// ---------- 本地待推送队列（先推后拉：本地秒写入队，此处统一写飞书） ----------
function firstEmptyRowOf(csv) {
  const rows = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return rows.length + 1;
}

function pushRecordItem(item) {
  const args = ['base', '+record-upsert', '--as', 'user',
    '--base-token', CONFIG.base.base_token, '--table-id', item.target.table_id,
    '--json', JSON.stringify(item.payload)];
  if (item.target.record_id) args.push('--record-id', item.target.record_id);
  const r = lark(args, 180000);
  const env = r.status === 0 ? parseEnvelope(r.stdout) : null;
  if (!env || env.ok !== true) {
    throw new Error(`record-upsert 失败：${((r.stderr || r.stdout || r.error?.message || '').trim().slice(-200))}`);
  }
  const flat = JSON.stringify(env);
  item.record_id = env.data?.record?.record_id || env.data?.record_id || (flat.match(/rec[A-Za-z0-9]{6,}/) || [])[0] || null;
  item.remote_hint = (flat.match(/https?:\/\/\S+/) || [])[0] || null;
  item.raw_response = flat.slice(0, 600);
}

function pushSheetAppendItem(item) {
  const cfg = CONFIG.sheet;
  const tmpJson = 'tmp_base/_push_csv_tmp.json';
  const tmpAbs = path.join(WORKSPACE, tmpJson);
  try {
    const r = lark(['sheets', '+csv-get', '--as', 'user',
      '--spreadsheet-token', cfg.spreadsheet_token, '--sheet-id', item.target.sheet_id,
      '--include-row-prefix=false', '--format', 'csv', '--output-path', tmpJson], 180000);
    if (r.status !== 0) throw new Error(`csv-get 失败：${((r.stderr || r.stdout || '').trim().slice(-200))}`);
    const payload = JSON.parse(fs.readFileSync(tmpAbs, 'utf8'));
    const data = payload.data || payload;
    const row = firstEmptyRowOf(data.annotated_csv ?? data.csv ?? '');
    const r2 = lark(['sheets', '+cells-set', '--as', 'user',
      '--spreadsheet-token', cfg.spreadsheet_token, '--sheet-id', item.target.sheet_id,
      '--range', `A${row}:G${row}`,
      '--cells', JSON.stringify([item.payload.row.map((v) => ({ value: v }))]),
      '--allow-overwrite=false'], 120000);
    const env2 = r2.status === 0 ? parseEnvelope(r2.stdout) : null;
    if (!env2 || env2.ok !== true) {
      throw new Error(`cells-set 失败：${((r2.stderr || r2.stdout || '').trim().slice(-200))}`);
    }
    item.remote_hint = `${cfg.wiki_url}?sheet=${item.target.sheet_id}（写入第 ${row} 行）`;
  } finally {
    try { fs.rmSync(tmpAbs, { force: true }); } catch { /* 忽略清理失败 */ }
  }
}

function syncPush(st) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json')).sort();
  let pushed = 0, failed = 0, dry = 0;
  for (const f of files) {
    const p = path.join(PENDING_DIR, f);
    let item;
    try { item = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (item.status !== 'pending') continue;
    if (PUSH_DRY) {
      log(`[push-dry] 将推送 ${item.id} ${item.op} → ${JSON.stringify(item.target)}（入队于 ${item.created_at}，双确认凭证：${item.confirm_note}）`);
      dry++;
      continue;
    }
    try {
      if (item.op === 'record') pushRecordItem(item);
      else if (item.op === 'sheet-append') pushSheetAppendItem(item);
      else throw new Error(`未知操作类型：${item.op}`);
      item.status = 'pushed';
      item.pushed_at = nowTs();
      item.last_error = null;
      pushed++;
      log(`push：✅ ${item.id} 已写飞书${item.remote_hint ? `（${item.remote_hint}）` : ''}`);
    } catch (e) {
      item.push_attempts = (item.push_attempts || 0) + 1;
      item.last_error = String(e.message || e).slice(0, 300);
      failed++;
      log(`push：❌ ${item.id} ${item.last_error}（保留待推送，下次同步自动重试）`);
    }
    atomicWrite(p, JSON.stringify(item, null, 2) + '\n');
  }
  st.status = 'ok';
  st.last_ok = nowTs();
  st.detail = { pushed_now: pushed, failed_now: failed, dry_planned: dry };
}

// ---------- 索引生成 ----------
function statusSymbol(s) {
  return { ok: '✅', failed: '❌', diverged: '🔀', skipped: '⏸', running: '⏳' }[s] || '❔';
}

function pushLines() {
  const st = state.resources.push;
  if (!st) return [];
  let pending = 0, failed = 0, oldest = null;
  try {
    for (const f of fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const it = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'));
        if (it.status !== 'pending') continue;
        pending++;
        if (it.last_error) failed++;
        if (!oldest || it.created_at < oldest) oldest = it.created_at;
      } catch { /* 忽略坏文件 */ }
    }
  } catch { /* 目录不存在 */ }
  return [
    '## 本地待推送队列',
    '',
    `表格写操作走**本地入队 → 周期推送**（双确认后用 \`scripts/sync/table-write.mjs\` 入队，本同步 push 阶段统一写飞书，先推后拉）：当前待推送 **${pending}** 条${oldest ? `（最旧 ${oldest}）` : ''}${failed ? `，其中 ${failed} 条上次推送失败、将自动重试` : ''}；本次推送成功 ${st.detail?.pushed_now ?? 0} 条。明细见 \`tmp_base/pending/\` 各文件的 status/record_id/last_error。`,
    '',
  ];
}

function buildIndex() {
  const res = state.resources;
  const rows = [];
  const pushRow = (key, linkText, linkUrl, localPath) => {
    const r = res[key];
    if (!r) return;
    let scale = '';
    if (r.type === 'faq') scale = `revision ${r.detail.revision ?? '?'}`;
    else if (r.type === 'base') scale = `rev ${r.detail.rev ?? '?'} · ${r.detail.records ?? '?'} 条`;
    else if (r.type === 'sheet') scale = `rev ${r.detail.workbook_rev ?? '?'} · ${r.detail.rows ?? '?'} 行 × ${r.detail.cols ?? '?'} 列`;
    else if (r.type === 'git') {
      scale = `\`${r.detail.head}\` ${r.detail.subject || ''}`.trim();
      if (r.detail.pulled) scale += `（本次拉取 ${r.detail.pulled} 个提交）`;
      else if (r.detail.behind_before === 0) scale += '（已是最新）';
    }
    rows.push(
      `| ${r.name} | ${statusSymbol(r.status)} ${r.status} | [${linkText}](${linkUrl}) | \`${localPath}\` | ${r.last_ok || '—'} | ${scale} |`,
    );
  };

  pushRow('faq', '打开飞书原文', CONFIG.faq.wiki_url, CONFIG.faq.output);
  for (const t of CONFIG.base.tables) {
    const url = `${CONFIG.base.wiki_entry}?table=${t.table_id}${t.view ? `&view=${t.view}` : ''}`;
    pushRow(`base:${t.table_id}`, `${CONFIG.base.name} · ${t.name}`, url, t.output);
  }
  const sheetKeys = Object.keys(res)
    .filter((k) => k.startsWith('sheet:'))
    .sort((a, b) => (res[a].detail?.index ?? 0) - (res[b].detail?.index ?? 0));
  for (const k of sheetKeys) {
    const id = k.slice(6);
    pushRow(k, `${CONFIG.sheet.name} · ${res[k].name}`, `${CONFIG.sheet.wiki_url}?sheet=${id}`, res[k].detail?.file || '');
  }
  pushRow('git', 'GitHub 仓库', CONFIG.git.web_url, path.basename(CONFIG.git.repo));

  const all = Object.values(res);
  const bad = all.filter((r) => r.status === 'failed' || r.status === 'diverged');
  const okN = all.filter((r) => r.status === 'ok').length;
  const skipN = all.filter((r) => r.status === 'skipped').length;
  const overall = bad.length
    ? `⚠️ ${bad.length} 项异常`
    : skipN
      ? `✅ ${okN}/${all.length} 成功（⏸ ${skipN} 项本次未执行）`
      : '✅ 全部成功';
  const faqSt = res.faq?.detail || {};
  const sedimentLines = [
    '## 本地沉淀区状态',
    '',
    faqSt.sediment_entries
      ? `FAQ 复刻文件沉淀区现有 **${faqSt.sediment_entries} 条**本地沉淀（约 ${(faqSt.sediment_bytes / 1024).toFixed(1)} KB）未推回飞书。已推回 wiki 的条目请从复刻文件末尾标记以下删除。`
      : 'FAQ 复刻文件沉淀区当前为空（无未推回的本地沉淀）。',
    '',
    '## 失败详情',
    '',
  ];
  if (bad.length === 0) {
    sedimentLines.push('无。');
  } else {
    for (const r of bad) sedimentLines.push(`- **${r.name}**（${r.status}）：${r.error || '无错误信息'}`);
  }

  const md = [
    '# Nexent 支撑资源索引',
    '',
    `> 本文件由 \`scripts/sync/sync-all.mjs\` 自动生成于 ${nowTs()}，勿手工编辑。定时同步：ZCode 自动化每天 08:30。`,
    '',
    `**总体状态**：${overall}（${all.length - bad.length}/${all.length} 项成功）｜ **飞书授权**：${state.auth?.ok ? '✅ user 身份有效' : '❌ 已失效'} ${state.auth?.ok ? '' : '→ 见下方排错'}`,
    `**手动同步**：\`node scripts/sync/sync-all.mjs\`（可加 \`--only git|faq|base|sheet\`），或双击 \`scripts\\sync\\sync.cmd\``,
    '',
    '| 资源 | 状态 | 网页链接 | 本地缓存 | 最近同步成功 | 版本/规模 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    ...pushLines(),
    '',
    ...sedimentLines,
    '',
    '## 排错',
    '',
    '- 飞书授权失效：终端运行 `lark-cli auth login` 重新授权后重跑同步。',
    '- 单项失败不影响其他资源；逐次运行日志见 `scripts/sync/state/`，累计状态见 `scripts/sync/state/sync-state.json`。',
    '- FAQ 二进制附件（如 410MB 镜像 tar）不做本地缓存，按复刻文件中的占位说明从原文档获取。',
    '- 表格**写操作**：双确认后用 `scripts/sync/table-write.mjs` 本地入队（秒级），随本同步的 push 阶段统一写飞书（先推后拉）；仅紧急场景直写（lark-cli + --dry-run 预览后真写）。',
    '',
  ].join('\n');
  atomicWrite(INDEX_PATH, md);
}

// ---------- 主流程 ----------
function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] || '').split(',').map((s) => s.trim()) : null;
  const want = (k) => !only || only.includes(k);

  log(`=== Nexent 资源同步开始 ${nowTs()} ===`);

  // 本次未执行的资源统一标记 skipped，避免残留上次运行的状态误导统计
  for (const r of Object.values(state.resources)) {
    r.status = 'skipped';
    r.error = null;
  }

  // 飞书授权（git 不依赖）
  const needLark = want('push') || want('faq') || want('base') || want('sheet');
  let auth = { ok: false, msg: '未检测（--only git）' };
  if (needLark) {
    auth = checkAuth();
    if (!auth.ok) log(`⚠️ 飞书授权不可用：${auth.msg}`);
    state.auth = { ...auth, checked_at: nowTs() }; // 仅真实检测时更新，局部运行保留上次结果
  }

  if (want('git')) {
    const st = initResource('git', {
      type: 'git', name: CONFIG.git.name,
      source_url: CONFIG.git.web_url, local_path: CONFIG.git.repo,
    });
    try { syncGit(st); } catch (e) { st.status = 'failed'; st.error = String(e); }
    log(`git：${statusSymbol(st.status)} ${st.detail?.head || ''} ${st.error || ''}`);
  }

  if (needLark && !auth.ok) {
    for (const key of ['faq', ...CONFIG.base.tables.map((t) => `base:${t.table_id}`)]) {
      const meta = key === 'faq'
        ? { type: 'faq', name: CONFIG.faq.name, source_url: CONFIG.faq.wiki_url, local_path: CONFIG.faq.output }
        : { type: 'base', name: `${CONFIG.base.name} · ${CONFIG.base.tables.find((t) => `base:${t.table_id}` === key).name}`, source_url: '', local_path: '' };
      const st = initResource(key, meta);
      st.status = 'failed';
      st.error = `跳过：飞书授权失效。${auth.msg}`;
    }
    if (want('push')) {
      const st = initResource('push', { type: 'push', name: '本地待推送队列', source_url: '', local_path: 'tmp_base/pending' });
      st.status = 'failed';
      st.error = `跳过：飞书授权失效，本地待推送顺延。${auth.msg}`;
    }
  } else {
    if (want('push')) {
      const st = initResource('push', { type: 'push', name: '本地待推送队列', source_url: '', local_path: 'tmp_base/pending' });
      try { syncPush(st); } catch (e) { st.status = 'failed'; st.error = String(e); }
      log(`push：${statusSymbol(st.status)} 本次推送 ${st.detail?.pushed_now ?? 0} 条${st.detail?.failed_now ? `，失败 ${st.detail.failed_now} 条（保留重试）` : ''}${st.detail?.dry_planned ? `，[dry-run] 计划推送 ${st.detail.dry_planned} 条` : ''}${st.error ? ' ' + st.error : ''}`);
    }
    if (want('faq')) {
      const st = initResource('faq', {
        type: 'faq', name: CONFIG.faq.name, source_url: CONFIG.faq.wiki_url, local_path: CONFIG.faq.output,
      });
      try { syncFaq(st); } catch (e) { st.status = 'failed'; st.error = String(e); }
      log(`faq：${statusSymbol(st.status)} revision ${st.detail?.revision ?? '?'}${st.error ? ' ' + st.error : ''}`);
    }
    if (want('base')) {
      for (const t of CONFIG.base.tables) {
        const st = initResource(`base:${t.table_id}`, {
          type: 'base', name: `${CONFIG.base.name} · ${t.name}`,
          source_url: `${CONFIG.base.wiki_entry}?table=${t.table_id}`, local_path: t.output,
        });
        try { syncBaseTable(st, t); } catch (e) { st.status = 'failed'; st.error = String(e); }
        log(`base ${t.name}：${statusSymbol(st.status)} rev ${st.detail?.rev ?? '?'} · ${st.detail?.records ?? '?'} 条${st.error ? ' ' + st.error : ''}`);
      }
    }
    if (want('sheet')) {
      const cfg = CONFIG.sheet;
      const r = lark(['sheets', '+workbook-info', '--spreadsheet-token', cfg.spreadsheet_token, '--json', '--as', 'user'], 120000);
      const env = r.status === 0 ? parseEnvelope(r.stdout) : null;
      if (!env) {
        const st = initResource('sheet:workbook', { type: 'sheet', name: cfg.name, source_url: cfg.wiki_url, local_path: cfg.output_dir });
        st.status = 'failed';
        st.error = `workbook-info 失败：${((r.stderr || r.stdout || '').trim().slice(-300))}`;
        log(`sheet：❌ ${st.error}`);
      } else {
        const wb = env.data;
        log(`sheet：发现 ${wb.sheets.length} 个子表（workbook rev ${wb.revision}）`);
        // 清掉上次已不存在的子表状态
        for (const k of Object.keys(state.resources)) {
          if (k.startsWith('sheet:') && k !== 'sheet:workbook' && !wb.sheets.some((s) => `sheet:${s.sheet_id}` === k)) {
            delete state.resources[k];
          }
        }
        for (const s of wb.sheets) {
          if (s.is_hidden) continue;
          const st = initResource(`sheet:${s.sheet_id}`, {
            type: 'sheet', name: s.sheet_name, source_url: `${cfg.wiki_url}?sheet=${s.sheet_id}`,
            local_path: `${cfg.output_dir}/${cfg.output_prefix}_${s.sheet_name}.csv`,
          });
          st.detail.index = s.index;
          try { syncSheet(st, wb, s); } catch (e) { st.status = 'failed'; st.error = String(e); }
          log(`sheet ${s.sheet_name}：${statusSymbol(st.status)} ${st.detail?.actual_range || ''}${st.error ? ' ' + st.error : ''}`);
        }
      }
    }
  }

  state.last_run = nowTs();
  atomicWrite(path.join(STATE_DIR, 'sync-state.json'), JSON.stringify(state, null, 2) + '\n');
  buildIndex();

  // 日志文件只留最近 30 份
  try {
    const logs = fs.readdirSync(STATE_DIR).filter((f) => /^sync-\d{8}\.log$/.test(f)).sort();
    for (const f of logs.slice(0, Math.max(0, logs.length - 30))) fs.rmSync(path.join(STATE_DIR, f), { force: true });
  } catch { /* 忽略 */ }

  const all = Object.values(state.resources);
  const bad = all.filter((r) => r.status === 'failed' || r.status === 'diverged');
  const skipN = all.filter((r) => r.status === 'skipped').length;
  log(`=== 同步结束：${all.length - bad.length - skipN}/${all.length} 项成功${skipN ? `，${skipN} 项未执行` : ''}，索引已更新 → tmp_base/资源索引.md ===`);
  process.exit(bad.length ? 1 : 0);
}

main();
