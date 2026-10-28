#!/usr/bin/env node
/**
 * 表格本地写入队列 —— 本地秒写入队，随 sync-all.mjs 周期推送飞书
 *
 * 背景：逐单直写飞书太慢（每次都要授权+网络往返十几秒）。本脚本把写操作先落本地
 * 队列（毫秒级、不联网），由每日 08:30 的 sync-all.mjs「push 阶段」统一写飞书
 * （先推后拉：推送成功后再拉取远端刷新本地缓存，顺序保证缓存包含刚写入的记录）。
 *
 * 用法：
 *   入队（新增记录） node table-write.mjs --op record --table-id tbleCKbGHEEDvc32 \
 *                      --json '{"问题描述":"...","问题局点":["华西医院"],"责任模块":["模型管理"],"问题发现版本":["v2.7.0"]}' \
 *                      --confirm-note "双确认完成：内容确认+操作允许（2026-10-20）"
 *   入队（更新记录） 同上，加 --record-id recvXXXX
 *   入队（跟踪表追加行） node table-write.mjs --op sheet-append --sheet-id qQKCIP \
 *                      --row '["2026年10月20日","张三","事件一句话","结论一句话","否","易"]' \
 *                      --confirm-note "..."
 *   查看            node table-write.mjs --list [--all]
 *   撤销            node table-write.mjs --cancel <id>   （仅「待推送」可撤）
 *
 * 门禁：未带 --confirm-note（双确认凭证）的入队会被拒绝——「内容确认 + 操作允许」
 *       必须在入队前完成（支撑流程⑥），凭证原文随条目留痕。
 * 目标表必须是 sync-config.json 里登记过的表；推送结果（record_id / 失败原因）写回
 * 各 pending 文件并汇总到 tmp_base/资源索引.md「本地待推送队列」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(SCRIPT_DIR, '..', '..');
const PENDING_DIR = path.join(WORKSPACE, 'tmp_base', 'pending');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'sync-config.json'), 'utf8'));
const TABLES = Object.fromEntries(CONFIG.base.tables.map((t) => [t.table_id, t]));

const pad = (n) => String(n).padStart(2, '0');
const nowTs = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const argvOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const has = (flag) => process.argv.includes(flag);

// 轻校验（本地字段快照，不联网）：问题跟踪表必填 4 项 + 字段快照存在性提示
function validateRecord(tableId, data) {
  const warnings = [];
  if (tableId === 'tbleCKbGHEEDvc32') {
    for (const f of ['问题描述', '问题局点', '责任模块', '问题发现版本']) {
      if (data[f] === undefined || data[f] === '' || (Array.isArray(data[f]) && data[f].length === 0)) {
        warnings.push(`问题跟踪表必填字段「${f}」为空（规范见 templates.md 第四节）`);
      }
    }
  }
  if (!fs.existsSync(path.join(WORKSPACE, 'tmp_base', `fields_${tableId}.json`))) {
    warnings.push(`本地无字段快照 fields_${tableId}.json，未校验取值，推送时以飞书校验为准`);
  }
  return warnings;
}

function enqueue(op, target, payload, confirmNote) {
  if (!confirmNote || !confirmNote.trim()) {
    console.error('❌ 拒绝入队：缺少 --confirm-note。双确认硬门禁（内容确认+操作允许）必须在入队前完成，并把凭证写入该参数。');
    process.exit(1);
  }
  const id = `${op}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  const item = {
    id, created_at: nowTs(), op, target, payload,
    confirm_note: confirmNote.trim(),
    status: 'pending', push_attempts: 0, last_error: null,
    pushed_at: null, record_id: null, remote_hint: null, raw_response: null,
  };
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(path.join(PENDING_DIR, `${id}.json`), JSON.stringify(item, null, 2) + '\n', 'utf8');
  console.log(`✅ 已入队（本地写入，毫秒级，不联网）：${id}`);
  console.log(`   目标：${op} → ${JSON.stringify(target)}`);
  console.log('   飞书写入将随周期同步执行：每日 08:30 自动，或手动 node scripts/sync/sync-all.mjs --only push');
  console.log(`   查看：node scripts/sync/table-write.mjs --list ｜ 撤销：--cancel ${id}`);
}

function list(all) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json')).sort();
  const rows = [];
  for (const f of files) {
    try {
      const it = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'));
      if (!all && it.status !== 'pending') continue;
      const summary = it.op === 'record'
        ? (it.payload['问题描述'] || JSON.stringify(it.payload)).slice(0, 48)
        : JSON.stringify(it.payload.row).slice(0, 48);
      rows.push(`${it.id}  [${it.status}]  ${it.created_at}  ${it.op} → ${JSON.stringify(it.target)}  ${summary}${it.last_error ? `  ⚠️ ${it.last_error}` : ''}`);
    } catch {
      rows.push(`${f}  [损坏文件，已忽略]`);
    }
  }
  console.log(rows.length ? rows.join('\n') : '队列为空。');
  console.log(`\n（显示${all ? '全部' : '待推送'} ${rows.length} 条；推送结果明细见 tmp_base/pending/ 各文件的 status/record_id/last_error）`);
}

function cancel(id) {
  const file = path.join(PENDING_DIR, `${id}.json`);
  if (!id || !fs.existsSync(file)) { console.error(`❌ 找不到待推送条目：${id}`); process.exit(1); }
  const it = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (it.status !== 'pending') {
    console.error(`❌ ${id} 状态已是 ${it.status}（已推送飞书），不可撤销；如需远端修正请新建一条更新操作（--record-id ${it.record_id || '记录ID'}）。`);
    process.exit(1);
  }
  fs.rmSync(file);
  console.log(`✅ 已撤销待推送条目：${id}`);
}

// ---- main ----
if (has('--list')) { list(has('--all')); process.exit(0); }
const cancelId = argvOf('--cancel');
if (cancelId) { cancel(cancelId); process.exit(0); }

const op = argvOf('--op');
const confirmNote = argvOf('--confirm-note');
if (op === 'record') {
  const tableId = argvOf('--table-id');
  if (!tableId || !TABLES[tableId]) {
    console.error(`❌ --table-id 无效或不在 sync-config.json 登记范围内：${tableId}\n   可选：${Object.keys(TABLES).join(' / ')}`);
    process.exit(1);
  }
  let data;
  try { data = JSON.parse(argvOf('--json') || ''); } catch { console.error('❌ --json 不是合法 JSON'); process.exit(1); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
    console.error('❌ --json 需为非空对象（字段名 → 值）');
    process.exit(1);
  }
  validateRecord(tableId, data).forEach((w) => console.warn(`⚠️ ${w}`));
  const recordId = argvOf('--record-id');
  enqueue('record', { table_id: tableId, name: TABLES[tableId].name, ...(recordId ? { record_id: recordId } : {}) }, data, confirmNote);
} else if (op === 'sheet-append') {
  const sheetId = argvOf('--sheet-id');
  let row;
  try { row = JSON.parse(argvOf('--row') || ''); } catch { console.error('❌ --row 不是合法 JSON'); process.exit(1); }
  if (!sheetId) { console.error('❌ 缺少 --sheet-id（现网问题个人跟踪：9月=d35025，10月=qQKCIP；新月份先 +workbook-info 确认）'); process.exit(1); }
  if (!Array.isArray(row) || row.length !== 6 || row.some((c) => typeof c !== 'string')) {
    console.error('❌ --row 需为 6 个字符串的数组（A=时间 B=人员 C=事件 D=结论 E=是否闭环 F=修复难度）');
    process.exit(1);
  }
  const DIFFS = ['待评估', '易', '中', '难'];
  if (!DIFFS.includes(row[5])) {
    console.error(`❌ F 列修复难度限 ${DIFFS.join('/')}（当前：${row[5]}）`);
    process.exit(1);
  }
  enqueue('sheet-append', { sheet_id: sheetId, name: CONFIG.sheet.name }, { row }, confirmNote);
} else {
  console.error('用法（详见文件头注释）：\n  --op record --table-id <tbl> --json \'{...}\' --confirm-note "..." [--record-id <rec>]\n  --op sheet-append --sheet-id <id> --row \'["..."]\' --confirm-note "..."\n  --list [--all] ｜ --cancel <id>');
  process.exit(1);
}
