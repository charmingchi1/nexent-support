# A2A 证书校验开关迁移指南

> **适用问题**：A2A 外部协作智能体对端使用自签名/内部 CA 证书，旧版本强制校验证书，报
> `SSL: CERTIFICATE_VERIFY_FAILED`；需要从“全局热修复”迁移到官方 per-agent 开关 `ssl_verify`。
>
> **关联变更**：commit `84f06ffbb`（`fix(a2a): make external agent SSL verification configurable`），
> PR **#4184** 首次合入 develop（squash `43da669bf`，2026-10-23）；同一提交也出现在 PR #4208 的提交清单里。
>
> **关联问题单**：`reczz28PzSEv1hq2`（责任模块：智能体配置；预期修改版本：Nexent 1030 / v2.8.0）。
>
> **关联文档**：《热修复指南-A2A-ssl_verify-v2.6.1.md》——仅适用于**不能升级**的 v2.6.1 现场。
>
> **读者**：执行修复的支撑/运维 Agent。按本文顺序执行；每一步都有“通过标准”和“停手条件”。
> 不要在未确认版本、未备份数据库、未取得关闭证书校验的书面授权之前直接改库。

---

## 0. 先记住三件事

1. 官方修复不是“全局关校验”，而是**每个外部 A2A Agent 一个 `ssl_verify` 布尔字段，默认 `true`**。
   发现、刷新卡片、管理侧测试调用、对话调用都读同一个字段。
2. 升级到 v2.8.0/1030 后，旧容器里的热修复会随镜像替换消失；**已有 Agent 的 `ssl_verify` 一律是 `TRUE`**。
   之前靠热修复才能连上的自签 Agent 会重新报证书错误，必须做一次“按 Agent 关校验”的数据迁移。
3. v2.6.1 不能升级时，只能继续用全局热修复；**不要把开关半量 backport 到旧版本**。
   只加 UI、只加数据库列或只改 runtime 都不会完整生效，反而会制造“看起来配了但还报错”的假象。

### 最常见路径（v2.6.1 + 热修复现场）

```text
升级到 v2.8.0/1030
  → 确认 /opt/nexent/VERSION=v2.8.0 且数据库有 ssl_verify 列
  → 对之前自签的 Agent 执行 UPDATE ssl_verify=FALSE
  → 前端重新发现/刷新/对话验证
  → 日志中 CERTIFICATE_VERIFY_FAILED 计数为 0
```

---

## 1. 执行前判定（必须先做）

### 1.1 确认容器和版本

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E '^nexent-(config|runtime|postgresql)[[:space:]]'
```

**通过标准**：三个容器均为 `Up`。任一不在，先修复部署，不要继续。

```bash
docker exec nexent-config cat /opt/nexent/VERSION
```

**通过标准**：输出 `v2.8.0` 或更高。版本号不是唯一依据，还要继续做 1.2 的代码检查。
（若路径不存在，用 `docker exec nexent-config find /opt -maxdepth 4 -name VERSION` 定位。）

### 1.2 三层代码检查（缺一不可）

必须同时确认 **config 侧、runtime/SDK 侧、数据库** 三层都已包含开关。只升级了一半的镜像，是最常见的“发现能通、对话还报错”的原因。

**config 侧（发现/刷新/管理侧调用）**

```bash
docker exec nexent-config sh -c 'grep -n "ssl_verify=request.ssl_verify" /opt/backend/apps/a2a_client_app.py'
```

**通过标准**：输出 1 行。无输出说明 config 镜像还是旧版本。
（若 `/opt/backend` 不存在，用 `docker exec nexent-config find /opt -maxdepth 4 -name a2a_client_app.py` 定位。）

**runtime/SDK 侧（对话调用）**

```bash
docker exec nexent-runtime sh -c 'ls /opt/backend/.venv/lib/'
```

**通过标准**：输出形如 `python3.11`。记下实际版本，把下面命令中的 `python3.XX` 替换掉：

```bash
docker exec nexent-runtime sh -c 'grep -n "verify=self.agent_info.ssl_verify" /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py'
```

**通过标准**：输出 1 行。无输出说明 runtime 镜像或 SDK 还是旧版本。

若上面的固定路径不存在，用 find 定位实际安装位置（SDK 是 `uv pip install --link-mode copy`
装进 site-packages 的，改 `/opt/sdk` 源码无效）：

```bash
docker exec nexent-runtime sh -c 'find /opt -path "*nexent/core/agents/a2a_agent_proxy.py" 2>/dev/null'
```

**数据库**

先记下 PostgreSQL 的实际用户名和库名（不要硬编码 `root`/`nexent`）：

```bash
PGUSER=$(docker exec nexent-postgresql printenv POSTGRES_USER)
PGDB=$(docker exec nexent-postgresql printenv POSTGRES_DB)
```

> 以下命令都在同一个 shell 执行。变量丢失就重新执行上面两行。

```bash
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -Atc \
"SELECT column_name || '|' || data_type || '|' || is_nullable || '|' || COALESCE(column_default,'')
 FROM information_schema.columns
 WHERE table_schema='nexent' AND table_name='ag_a2a_external_agent_t' AND column_name='ssl_verify';"
```

**通过标准**：输出包含 `ssl_verify|boolean|NO`，默认值显示为 `true` 或 `'true'::boolean`。
（不同 PostgreSQL 版本对布尔默认值的文本表示可能不同，以 `boolean / NO / 默认 true` 为准。）

> 查询为空时先别下结论：用 A1 的 `to_regclass` 确认表是否存在。
> 表不存在说明该环境还没用过 A2A（不是迁移失败）；表存在但列不存在才是缺迁移。

### 1.3 判定路线

| config 侧 | runtime/SDK 侧 | `ssl_verify` 列 | 结论 |
|---|---|---|---|
| 有 | 有 | 有 | **路线 A**：只做数据迁移和验证 |
| 有 | 有 | 无 | **路线 A（先补迁移）**：先执行 A1 的数据库迁移，再做 A2 数据迁移 |
| 无 | 无 | — | **路线 B**（升级）或**路线 C**（v2.6.1 热修复） |
| 有/无 混合 | — | — | **停手**：镜像升级不完整，先统一镜像，不要改库 |

### 1.4 备份（不可跳过）

> 如果换了新 shell，先重设 1.2 里的 `PGUSER` / `PGDB` 两个变量。

```bash
# 部署包根目录：含 deploy/docker/deploy.sh 和 deploy/env/.env 的目录。
# 不知道路径时先执行：find / -maxdepth 5 -path '*/deploy/docker/deploy.sh' 2>/dev/null
DEPLOY_ROOT=/path/to/deploy-root    # 替换为实际路径，不要保留尖括号
BK=~/nexent-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK"

docker exec nexent-postgresql pg_dump -U "$PGUSER" -d "$PGDB" -Fc -f /tmp/nexent_before_a2a_ssl.dump
docker cp nexent-postgresql:/tmp/nexent_before_a2a_ssl.dump "$BK"/
cp -a "$DEPLOY_ROOT/deploy/env/.env" "$BK"/env.bak
cp -a "$DEPLOY_ROOT/deploy/docker/deploy.options" "$BK"/deploy.options.bak 2>/dev/null || true

docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -c \
"\copy (SELECT id, tenant_id, name, source_type, source_url, ssl_verify FROM nexent.ag_a2a_external_agent_t WHERE delete_flag <> 'Y' ORDER BY id) TO '/tmp/a2a_agents_before.csv' CSV HEADER"
docker cp nexent-postgresql:/tmp/a2a_agents_before.csv "$BK"/

ls -lh "$BK"
```

**通过标准**：`$BK` 下同时看到 `.dump`、`env.bak`、`a2a_agents_before.csv`。
**停手条件**：`pg_dump` 失败或备份文件大小为 0。没有可用的数据库备份，不允许执行第 2 节任何写操作。

> 如果 `ag_a2a_external_agent_t` 不存在（新装环境还没用过 A2A），CSV 备份会报“relation does not exist”。
> 此时说明没有存量 A2A Agent 需要迁移，跳过 CSV 备份即可；升级后仍要确认列已创建。

### 1.5 找出“受影响 Agent”

“受影响”指对端使用自签名或内部 CA 证书、开启校验就必然失败的 Agent。按以下优先级确认：

1. **问现场负责人**：哪些外部 A2A Agent 使用自签名/内部 CA。这是最可靠的来源。
2. **用产品自身探测**：在添加外部智能体的弹窗里填该 Agent Card URL，**保持“校验 SSL 证书”勾选**，点发现。
   - 报 `CERTIFICATE_VERIFY_FAILED` → 受影响；
   - 发现成功 → 不受影响，保持 `TRUE`，不要关校验。
   - 服务边界的单测已覆盖“发现失败不写库”，可以安全探测；如担心，在探测前后各查一次
     同 `source_url` 的记录数，确认没有新增。
3. **容器内 TLS 探测**（可选，只验证证书链，不验证 A2A 协议）：

```bash
docker exec nexent-config python -c \
"import ssl,socket; h='<对端主机>'; p=443; c=ssl.create_default_context(); s=c.wrap_socket(socket.create_connection((h,p),5), server_hostname=h); print(s.getpeercert().get('issuer')); s.close()"
```

报 `CERTIFICATE_VERIFY_FAILED` 即证书链不被容器信任；把 `<对端主机>` 和端口换成实际 Agent Card 的地址。

> **安全边界**：对公网、证书链正常的外部 Agent，不要关闭校验。关校验会暴露中间人风险，
> 应由局点负责人书面确认。更合规的替代方案是导入对端 CA 到容器信任库（`SSL_CERT_FILE` 挂载），
> 保持 `ssl_verify=TRUE`。

---

## 2. 路线 A：新版本已含开关（推荐）

### A1. 确认/执行数据库迁移

先确认 A2A 表存在（不存在说明该环境还没有外部 Agent，或数据库未初始化）：

```bash
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -Atc \
"SELECT to_regclass('nexent.ag_a2a_external_agent_t') IS NOT NULL;"
```

**通过标准**：输出 `t`。输出 `f` 则停手，先确认数据库初始化状态。

再确认新版本的迁移文件已经进入容器的只读 SQL 目录：

```bash
docker exec nexent-config ls -l /opt/nexent/sql/migrations/v2.8.0_001_a2a_ssl_verify.sql
```

**通过标准**：文件存在。若不存在，说明部署包的 `deploy/sql` 没有随版本更新：

```bash
cp /path/to/new-package/deploy/sql/migrations/v2.8.0_001_a2a_ssl_verify.sql "$DEPLOY_ROOT/deploy/sql/migrations/"
```

> 更高版本可能已把该迁移合并进 `*_merged_migrations.sql`，此时单个文件不存在但列已创建。
> 先回到 1.2 确认 `ssl_verify` 列已存在：列存在就跳过复制/执行；列不存在才需要补文件或手工 SQL。

然后用产品自带的迁移 runner（内部有 advisory lock，可重复执行）：

```bash
docker exec nexent-config /opt/nexent/scripts/run-sql-migrations.sh --migrate
```

**通过标准**：日志出现以下之一：

```text
[sql-migrations] apply v2.8.0_001_a2a_ssl_verify.sql
[sql-migrations] skip v2.8.0_001_a2a_ssl_verify.sql
```

`skip` 表示之前已经执行过，正常。复核迁移记录和列：

```bash
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -Atc \
"SELECT migration_id || '|' || status FROM nexent.schema_migrations WHERE migration_id='v2.8.0_001_a2a_ssl_verify.sql';"
```

**通过标准**：输出 `v2.8.0_001_a2a_ssl_verify.sql|applied`。
如果走的是“手工兜底”且迁移文件不可用，这里可能为空；此时以 1.2 的列检查为准，并在交付记录中注明“手工执行、无 runner 记录”。

**兜底：runner 不可用或文件缺失时手工执行**（语句本身幂等）：

```bash
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -c \
"ALTER TABLE nexent.ag_a2a_external_agent_t ADD COLUMN IF NOT EXISTS ssl_verify BOOLEAN NOT NULL DEFAULT TRUE;"

docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -c \
"COMMENT ON COLUMN nexent.ag_a2a_external_agent_t.ssl_verify IS 'Verify peer TLS certificates for Agent Card retrieval and A2A invocation';"
```

手工执行后，如果迁移文件可用，再跑一次 runner 让它补记录；`ADD COLUMN IF NOT EXISTS` 不会重复生效。
**不要修改列默认值**：默认必须是 `TRUE`，新 Agent 默认开启校验。

### A2. 数据迁移：只对受影响的 Agent 关校验

先列出所有外部 Agent，留档并确认 ID：

```bash
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -P pager=off -c \
"SELECT id, tenant_id, name, source_type, ssl_verify, is_available, source_url
 FROM nexent.ag_a2a_external_agent_t
 WHERE delete_flag <> 'Y'
 ORDER BY id;"
```

#### 方式一：前端重新发现（适合逐个确认）

1. 打开该外部 Agent 所属本地智能体的编辑页 → **添加协作智能体 / 外部 Agent** → **A2A发现**；
2. 选择 URL 模式，填入与数据库中 `source_url` **完全一致**的 Agent Card URL；
3. **取消勾选**“校验 SSL 证书”（该复选框默认始终勾选，不会预填历史值）；
4. 点发现。成功后，后端按 `source_url + tenant_id + delete_flag <> 'Y'` 更新已有记录；
5. 如果提示“已添加/关系已存在”，忽略即可——记录已经在发现时更新，不需要再建一条关系。

> 注意：URL 必须与 `source_url` 完全一致（协议、端口、路径、尾部斜杠都算）。
> URL 不一致会新建一条记录，而不是更新原记录，随后会出现“旧记录还在报错”的假象。

#### 方式二：按 ID 直接改库（推荐批量/Nacos Agent）

```bash
AGENT_IDS="1,2"    # 替换为实际 ID，逗号分隔
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -c \
"UPDATE nexent.ag_a2a_external_agent_t
 SET ssl_verify = FALSE, update_time = now()
 WHERE id IN ($AGENT_IDS) AND delete_flag <> 'Y';"
```

**通过标准**：`UPDATE <n>`，`n` 等于预期条数。然后复核：

```bash
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -c \
"SELECT id, name, ssl_verify FROM nexent.ag_a2a_external_agent_t WHERE id IN ($AGENT_IDS);"
```

**Nacos 来源的 Agent**：前端 Nacos 面板没有“校验 SSL 证书”开关，只能按 ID 改库；
确认 `source_type='nacos'` 后使用上面的 SQL。

#### 方式三：整租户批量关闭（仅在书面授权后）

```bash
TENANT_ID="tenant-id"    # 替换为实际租户 ID
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -c \
"UPDATE nexent.ag_a2a_external_agent_t
 SET ssl_verify = FALSE, update_time = now()
 WHERE delete_flag <> 'Y' AND tenant_id = '$TENANT_ID';"
```

仅在“该租户所有外部 Agent 都是自签/内部 CA、负责人已书面确认”时使用。
**禁止**无 tenant 条件、无审批地全表关闭；**禁止**把列默认值改成 `FALSE`。

### A3. 生效与验证

代码路径每次发现/刷新/管理侧调用都会重新查库，runtime 每次运行会按数据库配置重建协作智能体代理，
**正常情况下改完库无需重启**。若验证不生效，先重启 `nexent-config nexent-runtime`，仍不生效按第 6 节排查。

**验证 1：数据库**

确认目标 Agent 为 `f`，未受影响的 Agent 仍为 `t`：

```bash
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -c \
"SELECT id, name, ssl_verify FROM nexent.ag_a2a_external_agent_t WHERE delete_flag <> 'Y' ORDER BY id;"
```

**验证 2：发现/刷新**

前端对该 Agent 重新发现、刷新卡片，均成功；失败提示不再是 `CERTIFICATE_VERIFY_FAILED`。

**验证 3：对话调用**

让主智能体调用该协作智能体，正常返回。
若发现成功但对话仍报证书错误，优先怀疑 runtime 侧未升级或未生效（见第 6 节）。

**验证 4：日志**

```bash
docker logs --since 10m nexent-config 2>&1 | grep -c "CERTIFICATE_VERIFY_FAILED" || true
docker logs --since 10m nexent-runtime 2>&1 | grep -c "CERTIFICATE_VERIFY_FAILED" || true
```

**通过标准**：两个计数均为 `0`。修复前 config 侧 aiohttp 有 3 次重试，通常会连报 3 次。

### A4. 验收清单

- [ ] `/opt/nexent/VERSION` 为 `v2.8.0` 或更高
- [ ] config 侧 `a2a_client_app.py` 含 `ssl_verify=request.ssl_verify`
- [ ] runtime 侧 `a2a_agent_proxy.py` 含 `verify=self.agent_info.ssl_verify`
- [ ] 数据库存在 `nexent.ag_a2a_external_agent_t.ssl_verify`，类型 boolean、NOT NULL、默认 true
- [ ] `nexent.schema_migrations` 有 `v2.8.0_001_a2a_ssl_verify.sql|applied`（手工兜底且文件不可用时可为空，但列必须存在并留档）
- [ ] 受影响 Agent 的 `ssl_verify` 为 `false`，且只改了确认受影响的 Agent
- [ ] 发现、刷新、对话三项均成功
- [ ] config/runtime 日志中 `CERTIFICATE_VERIFY_FAILED` 计数为 0
- [ ] 未修改列默认值；未对公网正常证书的 Agent 关闭校验
- [ ] 备份文件、执行前后 Agent 清单、验证输出已留档

---

## 3. 路线 B：低版本升级到 v2.8.0/1030

**适用**：版本低于 v2.8.0，且可以安排升级窗口。官方开关只随版本提供，不做旧版本补丁包。

### B1. 前置条件

- 已完成 1.4 的数据库和配置备份；
- 已取得变更窗口和维护通知；
- 已确认目标镜像/离线包为 v2.8.0 或更高，且包含 `deploy/sql/migrations/v2.8.0_001_a2a_ssl_verify.sql`；
- 已确认现场升级命令（不同局点的 `deploy.options`、镜像源、离线包流程不同，**不要自创参数**）。

### B2. Docker 标准部署升级示例

```bash
cd "$DEPLOY_ROOT"
bash deploy/docker/deploy.sh --defaults --version v2.8.0
```

- `--defaults` 复用已保存配置；现场如使用 `--use-local-config` 或离线包脚本，按现场 runbook 替换。
- **只执行 `docker restart` 不会更换镜像**，必须通过 deploy 脚本/`docker compose up -d` 重建容器。
- 热修复文件在容器可写层，容器重建后自动消失，不需要手工删除。

### B3. 升级后检查

```bash
docker inspect -f '{{.Config.Image}}' nexent-config
docker exec nexent-config cat /opt/nexent/VERSION
docker logs --tail 300 nexent-config 2>&1 | grep "v2.8.0_001_a2a_ssl_verify.sql"
```

**通过标准**：镜像 tag/版本为 v2.8.0+，日志出现 `apply` 或 `skip`。
如果日志没有该文件，先回到 1.2 确认列是否已存在：列存在说明该版本已合并迁移，可跳过；
列不存在再按 A1 检查 SQL 目录并补执行迁移。

### B4. K8s / 离线包

- K8s：按现场 release/namespace 执行标准 `deploy/k8s/deploy.sh` 或 Helm 升级；迁移 SQL 由
  `nexent-config` Pod 启动时执行。检查：
  ```bash
  NAMESPACE=nexent    # 替换为实际 namespace
  kubectl -n "$NAMESPACE" logs deploy/nexent-config | grep "v2.8.0_001_a2a_ssl_verify.sql"
  ```
- 离线包：使用新离线包的升级流程，确认 `deploy/sql/migrations/` 已随包更新；不要只替换镜像 tar。
- 升级完成后，**必须继续执行 A2 数据迁移**：已有 Agent 的 `ssl_verify` 默认是 `TRUE`，不会自动继承热修复的“全局关校验”。

### B5. 从热修复现场升级的关键风险

| 风险 | 说明 | 处置 |
|---|---|---|
| 热修复消失 | 新容器不再有 `ssl=False` / `verify=False` | 预期行为，靠 A2 的 per-agent 开关替代 |
| 已有 Agent 重新报错 | 迁移新增列默认 `TRUE` | 升级后立即按 A2 设置受影响 Agent |
| 只升级了 config | 发现能通、对话仍报错 | 同时确认 runtime 镜像和 SDK 版本（1.2） |
| SQL 目录未更新 | runner 看不到新迁移文件 | 按 A1 检查文件并补齐 |
| 误用旧包回滚 | 新 SQL 目录配旧镜像，迁移状态错乱 | 回滚必须用配套的旧包/旧镜像 |

---

## 4. 路线 C：v2.6.1 不能升级

**结论：v2.6.1 没有开关，不要尝试 backport。**

v2.6.1 的代码布局与 develop/v2.8.0 不同（例如后端客户端在 `utils/a2a_http_client.py`，
没有 `infrastructure/http/a2a.py`），且缺少 `ssl_verify` 字段、数据库列、SDK 参数和前端复选框。
只补其中一两层不会生效，典型表现：

- 只加 UI：请求字段被旧后端忽略，仍然强制校验；
- 只加数据库列：旧代码不读该列，仍然强制校验；
- 只改 config：发现能通，对话调用仍报错；
- 只改 runtime：发现仍报错。

**正确做法**：

1. 按《热修复指南-A2A-ssl_verify-v2.6.1.md》执行全局热修复（config + runtime 两个容器）；
2. 明确告知现场：这是**全局、临时、无 per-agent 控制**的手段，容器重建/升级即丢失；
3. 登记并推进升级到 v2.8.0/1030；升级时按路线 B + A2 完成正式迁移；
4. 安全上需局点负责人确认；有对端 CA 证书时，优先“导入信任库 + `SSL_CERT_FILE`”而不是关校验。

---

## 5. 回滚

### 5.1 只回滚某个 Agent 的开关

```bash
AGENT_IDS="1,2"    # 替换为实际 ID，逗号分隔
docker exec nexent-postgresql psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -c \
"UPDATE nexent.ag_a2a_external_agent_t
 SET ssl_verify = TRUE, update_time = now()
 WHERE id IN ($AGENT_IDS);"
```

### 5.2 回滚整个迁移的数据

用 1.4 备份的 `a2a_agents_before.csv` 对照恢复，或从 `pg_dump` 快照恢复。
不要直接删除 `ssl_verify` 列：新版本代码仍在读它，删列会导致 500。

### 5.3 回滚版本

- 用与旧版本配套的部署包/镜像回滚，不要用新 SQL 目录配旧镜像；
- 旧版本代码会忽略多出来的 `ssl_verify` 列，保留列是安全的；
- 如果回滚到 v2.6.1 且仍需自签互通，重新执行热修复指南；
- 回滚后重新核对：版本、容器、数据库列、日志，并留档。

---

## 6. 故障排查

| 现象 | 最可能原因 | 检查/处置 |
|---|---|---|
| 发现仍报 `CERTIFICATE_VERIFY_FAILED` | 记录 `ssl_verify` 仍为 true；或 URL 不一致新建了记录 | 按 `source_url` 查所有同名记录；确认前端请求带的是 `ssl_verify:false`；按 ID 改库 |
| 发现成功，对话仍报证书错 | runtime 镜像/SDK 未升级；或 runtime 未重建 | 跑 1.2 的 runtime 检查；确认镜像 tag；重启 `nexent-runtime` |
| 刷新卡片仍报证书错 | 刷新读的是数据库存量值 | 查该记录 `ssl_verify`；确认 config 版本；改库后重试刷新 |
| 改了库但 UI 列表没变化 | UI 列表缓存/未刷新 | 刷新页面；查看外部 Agent 列表接口返回（服务内路径 `/a2a/client/agents`，网关前缀按现场）；必要时重启 config |
| Nacos Agent 仍报错 | Nacos 面板没有开关，存量记录仍是 true | 按 ID 执行 `UPDATE ... ssl_verify=FALSE WHERE source_type='nacos'` |
| 报超时/连接拒绝，不再是证书错 | 网络、DNS、防火墙、对端未启动 | 不属于证书校验问题；按网络路径排查，不要继续关校验 |
| 发现接口 4xx/5xx，提示字段错误 | config 还是旧版本，不认 `ssl_verify` | 检查 1.2 config 代码；统一升级镜像 |
| 列不存在或迁移记录缺失 | 迁移文件没进 SQL 目录；runner 未执行 | 按 A1 检查文件、执行 runner/手工 SQL |
| 升级后所有自签 Agent 都报错 | 没有做 A2 数据迁移（新增列默认 TRUE） | 按 A2 逐个设置受影响 Agent；这是升级后的预期风险 |
| 只重启容器但版本没变 | 只 `restart` 没有重建容器/拉新镜像 | 用 deploy 脚本或 `docker compose up -d` 重建 |

---

## 7. 执行 Agent 的硬性规则

### 7.1 停手条件（满足任一即停止，不要继续改）

- 无法确认 `nexent-config` / `nexent-runtime` / `nexent-postgresql` 三个容器状态；
- 无法确认版本，或 config/runtime 代码检查结果不一致（半升级）；
- 数据库备份失败、备份文件为空、无法读取 `POSTGRES_USER`/`POSTGRES_DB`；
- 无法唯一确定要修改的 Agent（多个租户、同名记录、URL 不一致）；
- 现场未书面确认“允许对该 Agent 关闭证书校验”；
- 目标是对公网、证书链正常的外部 Agent。

### 7.2 禁止事项

- 禁止把 `ssl_verify` 列默认值改为 `FALSE`，或对新 Agent 默认关校验；
- 禁止在 v2.8.0 上再用 `ssl=False` / `verify=False` 打补丁（会绕过开关，且升级即丢失）；
- 禁止只 backport UI/数据库列/SDK 中的一层；
- 禁止无 tenant 条件、无审批地全表 `UPDATE`；
- 禁止在未备份时执行 `ALTER TABLE` / `UPDATE`；
- 禁止把内网地址、证书、日志原文上传到外部服务。

### 7.3 需要留下的证据

- `docker exec nexent-config cat /opt/nexent/VERSION` 输出；
- config/runtime 两处 `grep` 输出；
- `ssl_verify` 列查询、`schema_migrations` 记录；
- 修改前后的 Agent 清单（`id/name/source_url/ssl_verify`）；
- 发现/刷新/对话的成功结果；
- config/runtime 日志中 `CERTIFICATE_VERIFY_FAILED` 的计数；
- 备份文件路径和大小。

---

## 8. 附录：研发移植清单（仅研发使用）

如果必须把开关移植到其他分支，按下面清单完整实现；缺一层就会出现“部分生效”。
**支撑/运维 Agent 不要执行本节。**

| # | 文件 | 必须做的事 |
|---|---|---|
| 1 | `backend/database/db_models.py` | `A2AExternalAgent` 增加 `ssl_verify = Column(Boolean, nullable=False, default=True, server_default="true", ...)` |
| 2 | `deploy/sql/migrations/v2.8.0_001_a2a_ssl_verify.sql` | `ALTER TABLE nexent.ag_a2a_external_agent_t ADD COLUMN IF NOT EXISTS ssl_verify BOOLEAN NOT NULL DEFAULT TRUE;` + COMMENT |
| 3 | `backend/apps/a2a_client_app.py` | 生效的 `DiscoverFromUrlRequest` 增加 `ssl_verify: bool = True`，并传给 `discover_from_url` |
| 4 | `backend/consts/a2a_models.py` | 同名请求模型同步增加字段（保持契约一致；只改这里不生效） |
| 5 | `backend/management/services/agent/a2a/catalog.py` | 发现、刷新、健康检查、`call_agent`、`call_agent_streaming` 全部传 `ssl_verify`；从存量记录读取时用 `agent.get("ssl_verify", True)` |
| 6 | `backend/infrastructure/http/a2a.py` | `A2AHttpClient(ssl_verify=...)` → `aiohttp.TCPConnector(ssl=self.ssl_verify)` |
| 7 | `backend/database/a2a_agent_db.py` | 创建/更新时持久化；`get/list/query/refresh` 的返回字典全部带 `ssl_verify`；默认 `True` |
| 8 | `backend/agents/create_agent_info.py` | `ExternalA2AAgentConfig(ssl_verify=agent.get("ssl_verify", True))` |
| 9 | `sdk/nexent/core/agents/agent_model.py` + `a2a_agent_proxy.py` | 配置模型增加字段，`httpx.AsyncClient(verify=self.agent_info.ssl_verify)` |
| 10 | `frontend/services/a2aService.ts` + `A2AAgentDiscoveryModal.tsx` + 中英文 `common.json` | 类型增加 `ssl_verify?`；URL 模式增加默认勾选的复选框，发现请求带上该值 |

### 不变量

- 所有默认值必须是 `True`；显式 `false` 必须能一路透传到 config 和 runtime 的 HTTP 客户端；
- 发现时持久化，刷新/调用/流式调用都复用同一记录的值；
- `ssl_verify=None` 必须被请求模型拒绝（Pydantic `ValidationError`）；
- Nacos 来源没有 UI 开关，默认 `True`，需要时由 SQL 设置；
- 前端复选框默认勾选，不回填历史值（重新发现时需手动取消）。

### 回归测试

```bash
pytest -q \
  test/backend/services/test_a2a_ssl_verify.py \
  test/backend/services/test_a2a_client_service.py \
  test/backend/utils/test_a2a_http_client.py \
  test/backend/app/test_a2a_client_app.py \
  test/backend/database/test_a2a_agent_db.py \
  test/backend/agents/test_create_agent_info.py \
  test/sdk/core/agents/test_a2a_agent_proxy.py \
  test/sdk/core/agents/test_agent_model.py
```

```bash
cd frontend
npx vitest run --config vitest.workbench.config.ts \
  tests/workbench/A2ADiscoveryLoading.test.tsx \
  tests/workbench/A2ADiscoveryErrors.test.ts
```

> 注意：仓库内 e2e 用例 `test-e2e/changes/bugs/A2A-SSL-VERIFY-20261023.yaml` 明确标注
> “running-stack TLS integration、deployed UI、database migration execution”未覆盖。
> 因此升级/迁移后必须按本文做**真实部署验证**，不能只以单测通过作为交付依据。

---

## 9. 参考

- 原始提交：`84f06ffbb` — `fix(a2a): make external agent SSL verification configurable`
- 首次合入 PR：**#4184**（squash `43da669bf`，2026-10-23）；同一提交也在 PR #4208 的提交清单中
- 迁移脚本：`deploy/sql/migrations/v2.8.0_001_a2a_ssl_verify.sql`
- 问题跟踪单：`reczz28PzSEv1hq2`（责任模块：智能体配置；预期修改版本：Nexent 1030）
- v2.6.1 临时方案：《热修复指南-A2A-ssl_verify-v2.6.1.md》
- 相关但不同的问题：ModelEngine 模型提供方 `ssl_verify` 修复 PR #3968；nginx HTTPS 证书校验 PR #4026

---

## 附：给接手 Agent 的执行指令（可直接复制）

你是 Nexent A2A 证书校验修复的执行 Agent。请严格按本指南操作：

1. 先执行第 1 节，给出路线判定（A/B/C）和证据；未完成备份和授权确认前，禁止执行任何 `ALTER` / `UPDATE`。
2. 路线 A：按 A1→A2→A3→A4 顺序；路线 B：先升级，再回到 A；路线 C：只执行 v2.6.1 热修复指南，不要尝试开关。
3. 每一步的“通过标准”不满足就停手，输出实际命令输出和失败原因，不要跳过验证继续。
4. 只修改确认受影响的 Agent；禁止全表/全租户关闭校验，除非有书面授权。
5. 最终输出必须包含：版本、config/runtime 代码检查、数据库列和迁移记录、修改前后 Agent 清单、
   发现/刷新/对话结果、日志计数、备份路径。
6. 如果现场是内网/离线环境，只输出可复制的命令和文字，不上传任何内网数据。