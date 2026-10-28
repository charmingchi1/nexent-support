# nexent-support — Nexent 项目支撑技能包

一套跑在 ZCode 里的 Nexent 现网支撑工作环境：**支撑技能**（七步流程：受理补要素 → 检索 → 定性 → 答复/规避 → 升级 → 登记 → 沉淀）+ **每日自动同步脚本**（飞书 FAQ/多维表格/电子表格 → 本地缓存）+ **手工知识文档**。会话中说「华西又报错了」「这个怎么回」「帮我登记这个 bug」即自动接管。

```
┌─ ZCode 自动化（每天 08:30）─┐
│  「Nexent 支撑资源每日同步」 │──► node scripts/sync/sync-all.mjs ──┐
└────────────────────────────┘                                    ▼
┌─ nexent-support 技能 ─┐   ┌─ 同步脚本（scripts/sync/）─┐   ┌─ 数据源 ────────────┐
│ 会话中检索/定性/起草   │──►│ push→git→faq→base→sheet    │◄──│ ① nexent 代码仓(git) │
│ 登记入队(table-write) │   │ 生成 tmp_base/资源索引.md  │   │ ② 飞书 wiki/Base/表格 │
└──────────────────────┘   └───────────────────────────┘   └─────────────────────┘
        ▲                                                    调用 ▲
        └────────────── lark-cli（npm 全局包，user 身份 OAuth 授权）──┘
```

## 仓库内容

```
├── .agents/skills/nexent-support/   技能本体（SKILL.md + references/：faq-quick、templates、duty-map）
├── scripts/sync/                    同步脚本（sync-all.mjs / table-write.mjs / sync-config.json / sync.cmd）
├── Nexent支撑定性规范v2.md           ③定性判定树完整规范（手工维护）
├── Nexent已知限制清单.md             ⑦沉淀「暂不支持」类答复必查（手工维护）
└── .gitignore                       白名单模式：以上之外默认不入库
```

**不入库、由同步生成的运行时数据**（clone 后跑一次同步即全部恢复）：

| 路径 | 内容 | 生成方式 |
|------|------|----------|
| `tmp_base/Nexent平台部署FAQ-复刻.md` | FAQ 完整复刻（含末尾「本地沉淀区」） | 每日 faq 阶段，自飞书 wiki |
| `tmp_base/资源索引.md` | 同步状态 + 全部资源链接（勿手改） | 每次同步自动重建 |
| `tmp_base/rec_*.ndjson` `fields_*.json` | 项目管理一张表 6 张 Base 表缓存 | 每日 base 阶段 |
| `tmp_base/现网问题个人跟踪_*.csv` | 个人跟踪电子表格缓存 | 每日 sheet 阶段 |
| `tmp_base/pending/` | 表格写操作待推送队列 | table-write.mjs 入队 |
| `nexent/` | nexent 代码仓（develop） | 自行 clone，见步骤 4 |
| `scripts/sync/state/` | 同步运行日志与状态 | 脚本自动落盘 |

## 环境要求

- Windows + Git + Node.js ≥ 18
- [ZCode](https://zcode) （技能宿主；技能位于工作区 `.agents/skills/` 即自动识别）
- lark-cli ≥ 1.0.97：`npm install -g @larksuite/cli`
- 飞书自建应用 App ID：向前任支撑/主管索取（凭据不入库）

## 安装步骤（按序执行）

### 1. 克隆本仓库作为工作区根

技能与脚本内为绝对路径，**建议固定用 `D:\projects\feishu`**；换盘符/目录需同步改 `scripts/sync/sync-config.json` 的 `git.repo`、`lark_cli_entry` 及自动化 prompt 中的路径。

```bash
git clone https://github.com/charmingchi1/nexent-support.git "D:/projects/feishu"
```

### 2. 安装并授权 lark-cli

```bash
npm install -g @larksuite/cli
lark-cli --version      # ≥ 1.0.97
lark-cli auth login     # 浏览器扫码，完成 user 身份授权
lark-cli auth status    # 核对身份与有效期
```

⚠️ user refresh token 约 **7 天**过期；超过 7 天不用任何 lark-cli 命令授权整体失效——这是最常见故障，重新 `lark-cli auth login` 扫码即可，无需重装。

### 3. 核对 sync-config.json（唯一需要按环境修改的文件）

`scripts/sync/sync-config.json`：`lark_cli_entry`（npm 全局路径因机而异，Windows 下为
`%APPDATA%\npm\node_modules\@larksuite\cli\scripts\run.js`，脚本用 node 直调该 run.js）与
`git.repo`（代码仓绝对路径）。其余字段（FAQ/Base/表格的 URL 与 ID）为团队共用值，一般不动。

### 4. 克隆 nexent 代码仓

```bash
git clone https://github.com/ModelEngine-Group/nexent.git "D:/projects/feishu/nexent"
git -C "D:/projects/feishu/nexent" checkout develop
git -C "D:/projects/feishu/nexent" branch --set-upstream-to=origin/develop develop
```

之后无需手动更新——每日同步的 git 阶段自动 `fetch` + `pull --ff-only`。克隆慢时先配 Git 代理。
⚠️ 只用 `<工作区>/nexent`；`D:\projects\nexent` 是旧副本，检索会命中过时逻辑，勿用。

### 5. 首次同步（生成全部本地缓存）

```bash
node scripts/sync/sync-all.mjs --only git,faq   # 先小范围验证
node scripts/sync/sync-all.mjs                  # 全量：push→git→faq→base→sheet
```

成功标志：`tmp_base/资源索引.md` 生成且「总体状态」为 ✅，`tmp_base/` 出现 FAQ 复刻、6 张表 ndjson、个人跟踪 csv。除 push 阶段外脚本只读，不会写飞书；之后日常可双击 `scripts\sync\sync.cmd`。

### 6. 验证技能

用 ZCode 打开工作区，丢一个模拟问题（如「Supabase 初始化失败 can't start new thread」），应走完 ①受理补要素 → ②检索 → ④给出带模板的答复话术；在 `tmp_base/Nexent平台部署FAQ-复刻.md` 全文搜索已知关键词应命中。

### 7. （可选）重建每日 08:30 自动化

对 ZCode 说「**每天 08:30 创建自动化**」，要点：运行 `node "D:/projects/feishu/scripts/sync/sync-all.mjs"`（超时给足 10 分钟）→ 读 `tmp_base/资源索引.md` 汇报关键版本与失败项（授权失效提示重跑 `lark-cli auth login`）→ 除脚本内置 push 外不得调用任何飞书写命令、不改 FAQ 沉淀区、push_attempts ≥3 提醒人工。完整 prompt 见资料包《配置指南.md》§4.2（注意其中资源索引路径为旧版根目录，现为 `tmp_base/资源索引.md`）。

## 日常使用速查

```bash
node scripts/sync/sync-all.mjs --only push|git|faq|base|sheet   # 分阶段同步
node scripts/sync/sync-all.mjs --push-dry-run                   # 预览将推送内容
node scripts/sync/table-write.mjs --list [--all]                # 查看待推送队列
node scripts/sync/table-write.mjs --cancel <id>                 # 撤销待推送条目
```

- 表格写操作（⑥登记）必须先**双确认**（内容确认 + 操作允许，凭证写入 `--confirm-note`），本地入队后由每日同步 push 阶段批量写飞书；仅紧急场景才 lark-cli 直写（`--dry-run` 预览后真写，仍需双确认）；
- FAQ 新条目沉淀写进 FAQ 复刻文件**末尾「本地沉淀区」标记以下**——同步只更新标记以上的远端内容，沉淀区不会被覆盖；
- 字段规范见技能 `references/templates.md`；责任田归属见 `references/duty-map.md`（权威数据以「5 特性负责制」表实时查询为准）。

## 故障排查速查

| 症状 | 原因 | 处理 |
|------|------|------|
| 资源索引标「飞书授权已失效」 | user refresh token 超 7 天未用 | `lark-cli auth login` 重授权 → 手动重跑同步 |
| git 阶段失败：非快进 | 本地仓有游离改动 | `git -C nexent stash` 或确认后 `reset --hard origin/develop` |
| 报「找不到 lark-cli 入口」 | npm 全局路径变化 | 改 `sync-config.json` 的 `lark_cli_entry` 或设环境变量 `LARK_CLI_ENTRY` |
| 某资源 ❌ 其他正常 | 单项容错，常见为远端权限变化 | 看 `tmp_base/资源索引.md` 失败详情 + `scripts/sync/state/` 当日日志，找资源所有者开权限 |
| push 连续失败（attempts ≥3） | 字段值不合法/权限变化 | 看 `tmp_base/pending/` 各文件 `last_error`，修正后重新入队 |
| 自动化没跑 | 关机 / ZCode 未启动 | 双击 `scripts\sync\sync.cmd` 手动补跑 |

## 硬约束（详见 SKILL.md）

内网信息不出网（产物为纯文字话术，由人复制带回）；表格写入必须双确认；不确定的结论必须标「排查中」并限期 30 分钟，不允许归入终态了事。
