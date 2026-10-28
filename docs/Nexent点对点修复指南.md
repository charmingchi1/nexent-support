# Nexent 已部署环境点对点修复指南

> 适用对象：Nexent docker-compose 生产部署环境（以天舟环境为例，其他局点流程相同）
> 使用人：支撑工程师（执行）+ 局点运维人员（配合）
> 前置条件：问题已定性为显式 bug、修复 PR 已在研发侧明确、具备宿主机 SSH 权限

---

## 0. 什么是点对点修复 / 适用边界

**点对点修复**：不重新构建镜像、不做整包升级，直接在已部署环境上修改指定代码文件、复制进运行中的容器并重启该容器，使单个 bug 修复快速生效。

**适用**：显式 bug 需要紧急闭环、局点短期内无法发新版、修复已合入代码仓但未随版本发布。

**五条红线**（违反任何一条不得实施）：

1. **先备份后修改**——没有备份文件，不动环境；
2. **无《修复代码块文档》不实施**——所有修改必须有据可查（模板见附录 A）；
3. **未在运维群提前通知重启时间，不重启**；
4. **修复 PR 必须同步合入主干分支**——否则容器重建/版本升级后修复即丢失；
5. **仅限 Python 后端代码与配置类文件**——前端 `nexent-web` 为构建产物，不适用点对点修复，需走重新构建镜像流程。

---

## 1. 流程总览

| # | 步骤 | 产物 / 通过判据 |
|---|------|----------------|
| 1 | 确认部署版本和构建分支 | 环境信息表（版本、镜像 tag、涉及容器） |
| 2 | 迁移修复 PR，本地测试 | 基于部署基线验证通过的修复 commit |
| 3 | 输出《修复代码块文档》 | 逐文件 diff + 受影响容器清单 + 验证/回滚命令 |
| 4 | 与天舟运维同步计划，运维群提前通知重启时间 | 群内预告消息（模板见附录 B-1） |
| 5 | 在环境上备份需要修改的文件 | 备份目录 + CHECKSUMS 校验文件 |
| 6 | 依据文档进行宿主机代码修复 | 宿主机修复后文件，diff 与文档一致 |
| 7 | 将修复文件复制到运行中的容器 | 容器内文件 md5 与宿主机一致 |
| 8 | 重启容器 | 容器 Up、日志无报错、健康检查通过 |
| 9 | 验证服务修复正常可用 | 问题单复现步骤验证通过 + 主流程冒烟通过 |
| 10 | 收尾闭环 | 群内通报、问题单登记、PR 合入、文档归档 |

---

## 2. 第一步：确认部署版本和构建分支

登录宿主机，依次执行：

```bash
# 1) 容器清单与镜像 tag
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# 2) 部署所用的镜像版本（.env 在部署目录下）
grep -E "^NEXENT_IMAGE|^NEXENT_WEB_IMAGE" <部署目录>/env/.env

# 3) 反查 compose 部署目录（不确定部署位置时用）
docker inspect nexent-runtime --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'

# 4) 若宿主机保有代码仓：确认当前分支与 commit
cd <代码仓目录>
git branch --show-current && git log -1 --oneline
```

**判定**：修复 PR 所基于的 commit 是否已包含在部署版本中；不一致时，本地测试必须切到**部署 commit 的基线**上做（见第 3 节）。

### 容器与代码对照表（生产 compose 实际容器名）

| 容器 | 职责 | 代码入口 | 端口 |
|------|------|----------|------|
| nexent-config | 配置服务 | `backend/config_service.py` | 5010 |
| nexent-mcp | MCP 服务 | `backend/mcp_service.py` | 5011 / 5015 |
| nexent-data-process | 数据处理 | `backend/data_process_service.py` | 5012 |
| nexent-northbound | 北向 API | `backend/northbound_service.py` | 5013 |
| nexent-runtime | 运行时/智能体执行 | `backend/runtime_service.py` | 5014 |
| nexent-web | 前端 | 构建产物（**不可点对点修复**） | 3000 |
| nexent-elasticsearch / nexent-postgresql / nexent-redis / nexent-minio | 中间件 | — | — |

> **关键提醒**：四个后端服务（config / mcp / data-process / northbound / runtime）**共用同一镜像**，同一份代码文件可能被多个服务加载。修复文档必须列出**受影响容器**，后续复制文件和重启要覆盖全部受影响容器，漏一个就是隐患。
>
> 容器内代码路径：`/opt/nexent/backend/...`（启动脚本 `/opt/nexent/scripts/start-backend.sh`）。

---

## 3. 第二步：迁移修复 PR，本地测试

在本地开发机上：

```bash
# 1) 切到与部署一致的基线（以第一步确认的分支/commit 为准）
git fetch origin
git checkout <部署分支或部署commit>

# 2) 迁移修复 PR
git cherry-pick <修复commit>          # 方式一：cherry-pick
# 或方式二：应用补丁文件（外网 PR：在 PR 地址后加 .patch 下载）
git apply --check fix.patch && git apply fix.patch

# 3) 有冲突：按修复意图手工解决，逐文件与原 PR 比对，不引入额外改动
```

**本地验证（全部通过才算迁移成功）**：

1. 语法检查：`python3 -m py_compile <修改的文件>`；
2. 相关单元测试；
3. 本地起服务，按**问题单复现步骤**走一遍，确认修复生效；
4. 修复模块的主流程冒烟。

---

## 4. 第三步：输出《修复代码块文档》

本地测试通过后，按**附录 A 模板**输出文档，命名建议：`修复代码块-<日期>-<问题单号>-<一句话简述>.md`。

文档必须包含（缺一不可）：

- 环境基线信息（版本、镜像 tag、分支、commit）；
- **修改文件清单**：每个文件的宿主机路径、容器内路径、**受影响容器**（可能不止一个）；
- 每个文件的**修改前 / 修改后**完整代码块（或 unified diff）；
- 验证命令与回滚命令；
- 影响与风险说明。

后续所有操作只依据该文档执行，不实施文档之外的任何修改。

---

## 5. 第四步：与天舟运维同步计划，群内提前通知重启时间

与天舟环境运维人员同步以下内容，并**提前（建议至少半天）在运维群**发预告（模板见附录 B-1）：

| 同步项 | 内容 |
|--------|------|
| 修复原因 | 一句话 + 问题单号 |
| 影响范围 | 受影响容器、重启期间对应服务短暂不可用（单容器约 1~3 分钟） |
| 时间窗口 | 日期 + 开始/预计结束时间 |
| 配合事项 | 窗口期内避免其他部署操作；重启后协助页面/接口验证 |
| 回滚承诺 | 修复失败 N 分钟内回滚恢复 |

> 红线 3：未在运维群提前通知重启时间，不得执行第八步重启。开始前 15 分钟在群里再次确认（附录 B-2）。

---

## 6. 第五步：在环境上备份需要修改的文件

登录宿主机（示例时间戳变量后续各步复用）：

```bash
TS=$(date +%Y%m%d-%H%M)
BACKUP=~/nexent-hotfix-backup/$TS
mkdir -p $BACKUP

# 1) 宿主机部署目录中的现行文件
cp -a /path/to/deploy/backend/xxx.py $BACKUP/xxx.py.host.bak

# 2) 容器内现行文件（每个受影响容器各拉一份）
docker cp nexent-runtime:/opt/nexent/backend/xxx.py $BACKUP/xxx.py.runtime.bak

# 3) 生成校验和，留档
md5sum $BACKUP/* | tee $BACKUP/CHECKSUMS
```

在《修复代码块文档》的执行记录中写明备份目录 `$BACKUP`。

---

## 7. 第六步：依据修复代码块文档进行宿主机代码修复

**优先整文件上传，优于在环境上手工编辑**（避免手滑、缩进错乱）：

```bash
# 本地验证通过的修复文件，scp 上传宿主机部署目录对应位置
scp xxx.py user@<环境IP>:/path/to/deploy/backend/xxx.py
```

上传后在宿主机上校验：

```bash
# 1) diff 必须与《修复代码块文档》中的 diff 完全一致
diff -u $BACKUP/xxx.py.host.bak /path/to/deploy/backend/xxx.py

# 2) 语法检查
python3 -m py_compile /path/to/deploy/backend/xxx.py

# 3) md5 与本地验证通过的文件比对
md5sum /path/to/deploy/backend/xxx.py
```

任何不一致，停在这里重新核对文档，不带疑点进入下一步。

---

## 8. 第七步：将修复的代码文件复制到正在运行的容器

对《修复代码块文档》列出的**每一个受影响容器**逐一执行：

```bash
# 复制进容器（容器内路径以文档为准）
docker cp /path/to/deploy/backend/xxx.py nexent-runtime:/opt/nexent/backend/xxx.py

# 校验：容器内 md5 与宿主机一致
docker exec nexent-runtime md5sum /opt/nexent/backend/xxx.py
md5sum /path/to/deploy/backend/xxx.py
```

> 说明：`docker cp` 后文件在容器文件系统中即时更新，但**进程仍在运行旧代码**，必须执行第八步重启才能加载新代码。
> 同一文件被多个服务加载时，逐容器复制，**不要**用 `docker cp` 循环省事跳过校验。

---

## 9. 第八步：重启容器

开始前 15 分钟在运维群发确认消息（附录 B-2），然后：

```bash
# 重启全部受影响容器（示例：修复同时涉及 config 与 runtime）
docker restart nexent-config nexent-runtime

# 确认容器状态 Up
docker ps --format "table {{.Names}}\t{{.Status}}" | grep nexent

# 跟踪启动日志，确认无报错堆栈（Ctrl+C 退出跟踪，不影响服务）
docker logs -f --tail=100 nexent-config
docker logs -f --tail=100 nexent-runtime
```

**健康检查**（后端各服务内置 `/health/live` / `/health/ready`）：

```bash
docker exec nexent-config     curl -s http://127.0.0.1:5010/health/ready
docker exec nexent-mcp        curl -s http://127.0.0.1:5011/health/ready
docker exec nexent-northbound curl -s http://127.0.0.1:5013/health/ready
docker exec nexent-runtime    curl -s http://127.0.0.1:5014/health/ready
```

任一容器启动失败或健康检查不通过 → 立即进入第 11 节回滚。

---

## 10. 第九步：验证服务修复正常可用

按顺序三层验证，全部通过才算修复成功：

1. **探活**：第 9 节健康检查接口全部返回 ready；前端页面 `http://<环境IP>:3000` 可正常打开登录；
2. **修复验证**：按问题单复现步骤完整走一遍，确认问题现象消失；
3. **回归冒烟**：受影响模块的主流程（如相关页面、接口、智能体对话）验证无新问题。

验证通过 → 在运维群发完成通报（附录 B-3），进入收尾闭环。
验证失败 → 执行回滚（第 11 节），群内通报（附录 B-4），问题回到第 3 步重新核对修复方案。

---

## 11. 回滚预案（验证失败时执行）

```bash
# 1) 用第五步备份恢复容器内文件（每个受影响容器）
docker cp $BACKUP/xxx.py.runtime.bak nexent-runtime:/opt/nexent/backend/xxx.py

# 2) 同步还原宿主机部署目录文件
cp -a $BACKUP/xxx.py.host.bak /path/to/deploy/backend/xxx.py

# 3) 重启受影响容器
docker restart nexent-runtime

# 4) 健康检查 + 问题单复现步骤确认恢复原状
docker exec nexent-runtime curl -s http://127.0.0.1:5014/health/ready
```

回滚同样要在运维群通报（附录 B-4）。目标：**从决定回滚到服务恢复 ≤ 10 分钟**。

---

## 12. 收尾与闭环

1. **运维群通报完成**（附录 B-3）；
2. **问题单登记/更新**：按支撑流程⑥双确认登记，注明「已点对点修复，待随版本 N 正式带入」；
3. **修复 PR 合入主干分支**——这一步没做，点对点修复就不算完成；下次版本升级后核对修复已包含在版本内；
4. **文档归档**：《修复代码块文档》、备份目录 CHECKSUMS 一并留档；
5. **升级提醒**：容器**重建**（版本升级、`docker compose up --force-recreate`、更换镜像）会使容器内点对点修改丢失（`docker restart` 不受影响）。任何升级前，核对本环境尚存的点对点修复清单，确认已随版本带入或升级后重打。

---

## 附录 A：《修复代码块文档》模板

```markdown
# 修复代码块：<一句话简述>

## 1. 基本信息
- 问题单号 / 局点：
- 修复 PR / commit：
- 环境基线：Nexent 版本 <vX.Y.Z>，镜像 <NEXENT_IMAGE 值>，分支 <branch>，commit <hash>
- 拟实施日期 / 执行人：
- 影响说明：<重启哪些容器、期间哪个服务短暂不可用>

## 2. 修改文件清单
| 文件 | 宿主机路径 | 容器内路径 | 受影响容器 |
|------|-----------|-----------|-----------|
| xxx.py | /path/to/deploy/backend/xxx.py | /opt/nexent/backend/xxx.py | nexent-config, nexent-runtime |

## 3. 逐文件修改内容
### 3.1 backend/xxx.py（受影响容器：nexent-config, nexent-runtime）
修改前（关键段）：
```python
<原代码块>
```
修改后（关键段）：
```python
<新代码块>
```
（或附 unified diff）

## 4. 验证步骤
1. <问题单复现步骤，逐步列出>
2. <回归冒烟项>

## 5. 回滚步骤
1. docker cp $BACKUP/<文件>.runtime.bak <容器>:<容器内路径>
2. docker restart <受影响容器>
3. 健康检查：<命令>

## 6. 执行记录
| 时间 | 操作 | 结果 |
|------|------|------|
| | 备份 | |
| | 宿主机修复 | |
| | 容器复制 | |
| | 重启 | |
| | 验证 | |
```

---

## 附录 B：运维群通知模板

**B-1 计划预告（提前至少半天）**

> 【Nexent 点对点修复预告】各位好，<日期> <HH:MM-HH:MM> 拟对天舟环境执行一次点对点修复（问题单：<编号>，修复：<一句话>），需重启 <容器名列表>，期间对应服务预计中断 1~3 分钟。请窗口期内避免其他部署操作，并协助重启后页面验证。如有业务安排冲突请回复调整时间。

**B-2 开始前确认（提前 15 分钟）**

> 【Nexent 点对点修复即将开始】预计 <HH:MM> 开始重启 <容器名列表>，期间服务短暂不可用，预计 <HH:MM> 前完成，失败将在 10 分钟内回滚。请知悉。

**B-3 完成通报**

> 【Nexent 点对点修复完成】<容器名列表> 已于 <HH:MM> 重启完成，健康检查通过，问题单复现步骤验证通过，服务恢复正常。感谢配合。修复将随版本 <N> 正式带入。

**B-4 回滚通报**

> 【Nexent 点对点修复回滚】验证未通过，已于 <HH:MM> 完成回滚，服务已恢复正常运行。问题转回研发侧重新核实方案，后续另行预约窗口，抱歉给大家带来影响。

---

## 附录 C：执行前快速检查清单

- [ ] 已确认部署版本、镜像 tag、分支，修复 PR 基线与之一致
- [ ] 修复 PR 已迁移并在本地测试通过（复现步骤 + 冒烟）
- [ ] 《修复代码块文档》已输出，含受影响容器清单、diff、验证与回滚命令
- [ ] 运维群已提前通知重启时间窗口
- [ ] 环境上已完成备份并生成 CHECKSUMS
- [ ] 宿主机修复文件 diff 与文档一致、py_compile 通过
- [ ] 修复文件已复制到全部受影响容器，md5 比对一致
- [ ] 容器已重启，日志无报错，/health/ready 通过
- [ ] 问题单复现步骤验证通过，主流程冒烟通过
- [ ] 运维群已通报，问题单已登记，修复 PR 已合入主干
