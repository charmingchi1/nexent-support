<!-- 复刻自飞书 wiki 文档 · 由 scripts/sync/sync-all.mjs 自动同步；标记以上内容勿手工编辑，本地沉淀条目写在文件末尾标记以下 -->
<!-- 原文：https://dcnvjn24oieg.feishu.cn/wiki/IYhBwW2P9i51rZkLSIRcIZvNnoc -->
<!-- doc_id: D1QmdcttPopHnLxp8EIcUfxZnkg ｜ 同步时间：2026-10-28 08:30 ｜ revision: 392 -->
<!-- 二进制附件以占位说明保留，请从原文档获取 -->

# Nexent 平台部署常见问题排查与解决方案 (FAQ)

## 1. 登录后功能缺失与会话中断



### 问题现象



使用超级管理员账户 `suadmin@nexent.com` 登录平台后，页面出现以下异常：



- **功能缺失**：管理界面中未显示"租户列表"，也找不到"创建租户"的操作按钮。
- **会话中断**：刷新页面后，当前登录状态立即失效，被强制退出至登录页。

### 问题原因



该问题是由于**部署 Nexent 平台的服务器系统时间**与**客户端（或浏览器所在设备）的本地时间**存在较大偏差所致。



平台的安全机制在验证登录凭证（Cookie）时，会严格校验其有效期。当服务器时间与真实标准时间不一致时，系统会认为该 Cookie 要么尚未生效、要么已过期失效。这直接导致了两个后果：



1. **权限加载失败**：因会话被判定为无效，系统无法正确加载当前账号的管理权限，进而导致"租户列表"等管理功能入口未被渲染。
2. **会话被销毁**：刷新页面时，浏览器重新发起验证请求，服务端识别到时间偏差后拒绝承认该会话，因此强制清除了本地登录状态。

### 解决方案



**核心思路**：将 Nexent 服务器的系统时间校准至当前标准时间（北京时间，即 UTC+8）。



您可以根据服务器网络环境选择以下任一操作方式：



#### 方案一：在线同步（适用于服务器可连通公网）



1. 安装 NTP 时间同步工具（如 `chrony` 或 `ntpdate`）。
2. 配置与国内稳定的 NTP 服务器（如 `ntp.aliyun.com`）进行同步。
3. 同步完成后，执行 `hwclock --systohc` 将系统时间写入硬件时钟，确保重启后不失效。

```Bash
# 示例：使用 chrony
yum install -y chrony  # CentOS/RHEL
# 或 apt install -y chrony  # Ubuntu/Debian

systemctl start chronyd
systemctl enable chronyd
chronyc sources -v  # 验证同步状态
hwclock --systohc
```



#### 方案二：手动修正（适用于完全离线的服务器）



1. 使用 `date -s` 命令手动设置日期和时间（例如：`date -s "2026-06-25 14:00:00"`）。
2. **（关键步骤）** 同样执行 `hwclock --systohc` 命令，将手动设置的时间同步到主板硬件时钟，避免服务器重启后时间回退。

```Bash
date -s "2026-06-25 14:00:00"
hwclock --systohc
```



#### 验证方法



- 修改完成后，使用 `date` 命令确认服务器当前时间已正确。
- 重新登录 Nexent 平台，检查"租户列表"是否正常显示，刷新页面后是否仍保持登录状态。

---



## 2. Docker 23.0 及更早版本部署启动失败



### 问题现象



使用 **Docker 23.0 及更早版本**部署时，出现以下启动失败情况：



- **Supabase 数据库容器**启动失败，表现为 `db init`（数据库初始化）过程中报错退出。
- **后端应用容器**启动失败，报错信息包含 `can't start new thread`（无法创建新线程）。

### 问题原因



该问题的根本原因在于 **Docker 23.0 及旧版本的默认 seccomp（安全计算模式）配置**与 Supabase 内部组件（特别是 **PostgreSQL 数据库** 和 **Elixir 运行时**）的兼容性存在冲突。



具体机制如下：



1. **seccomp 简介**：seccomp 是 Linux 内核的安全机制，用于限制容器内进程可以调用的系统调用（syscall）。Docker 默认会加载一套安全策略，拦截部分高风险或非必要的系统调用。
2. **冲突点**：

   - **PostgreSQL 初始化（db init）** 过程中，需要调用某些特定的系统调用来完成共享内存管理、文件锁等底层操作。Docker 23.0 的默认 seccomp 策略对部分系统调用（如 `clone`、`futex` 等）的限制过于严格，导致初始化流程中断。
   - **Elixir 应用的线程创建（can't start new thread）**：Supabase 的某些后端服务（如 Realtime、Kong 等）基于 Erlang/Elixir 虚拟机（BEAM）运行，其运行时高度依赖动态线程和进程管理。当容器内尝试通过 `clone()` 等系统调用创建新线程时，被 seccomp 策略拦截，从而抛出 `can't start new thread` 错误。

> **注**：该问题在 Docker 23.0.1 及更高版本中部分修复，但考虑到兼容性稳定性，建议仍按如下方式显式配置。



### 解决方案



**核心思路**：在容器配置中显式放宽 seccomp 限制，允许容器执行所需的所有系统调用。



#### 操作步骤



需要在 `docker-compose.yml` 和 `docker-compose-supabase.yml` 文件中，为**所有服务**（尤其是 `nexent-postgresql` 和后端相关容器）添加 `security_opt` 配置项。



**修改示例**：



修改前（仅包含网络配置）：



```YAML
nexent-postgresql:
  image: postgres:15
  container_name: nexent-postgresql
  networks:
    - nexent
  # 其他配置...
```



修改后（添加 seccomp 放宽配置）：



```YAML
nexent-postgresql:
  image: postgres:15
  container_name: nexent-postgresql
  networks:
    - nexent
  security_opt:
    - seccomp:unconfined   # 禁用默认的 seccomp 安全限制
  # 其他配置...
```



#### 注意事项



1. **适用范围**：`seccomp:unconfined` 配置应添加到 Compose 文件中**所有服务**的 `security_opt` 列表下，而非仅限数据库服务，以确保所有容器均能正常启动。
2. **安全权衡**：该配置会**完全禁用该容器的 seccomp 安全限制**，容器内进程将拥有与宿主机上直接运行几乎相同的系统调用权限。在内网部署或受信环境中此操作风险较低；若部署在公共网络，请评估安全影响。
3. **升级建议**：若条件允许，建议将 Docker 升级至 **23.0.1 及以上版本**或 **24.0.x 稳定版**，这些版本优化了默认 seccomp 策略，无需额外配置。

#### 验证方法



修改配置文件后，重新执行部署。观察各容器日志，确认 `db init` 成功完成，且无 `can't start new thread` 报错即表示问题已解决。



---



## 3. 容器无法访问宿主机外部网络（连接超时）



### 问题现象



在宿主机上可以正常访问的模型或外部网络地址，在 Nexent 容器中接入失败，报错为**连接超时**。



### 问题原因



Docker 访问外部网络通常由 NAT（MASQUERADE）规则控制。但 Nexent 的自定义网络 `nexent_network` 使用的 `172.18.0.0/16` 网段缺少对应的 MASQUERADE 规则，导致容器流量无法进行源地址转换（SNAT），从而无法访问宿主机以外的网络。



### 解决方案



**核心思路**：为 `172.18.0.0/16` 网段手动添加一条 MASQUERADE 规则。



**执行命令：**



```Bash
iptables -t nat -A POSTROUTING -s 172.18.0.0/16 ! -o docker0 -j MASQUERADE
```



**验证方法：**



```Bash
# 查看规则是否已添加
iptables -t nat -L POSTROUTING -n -v | grep 172.18

# 测试容器访问外网
docker exec nexent-config ping -c 2 8.8.8.8
```



### 注意事项



- 该规则在重启 Docker 服务或宿主机后会**丢失**，需重新添加。
- 如需**永久生效**，可选择以下方式之一：

  - 保存 iptables 规则（使用 `iptables-save` 和 `iptables-restore` 配合开机启动脚本）。
  - 修改 `docker-compose.yml` 中的网络配置，添加 `ipam` 配置以使用其他网段（需确保该网段已被正确配置 NAT）。



## 4. 容器间网络通信问题



### 问题现象



部署过程中或部署完成后，容器之间无法通过容器名+端口相互进行访问，无法正常访问前端或服务异常，容器中日志一般提示为**域名解析失败。**



### 问题原因



防火墙规则或系统网络配置挡住了容器流量。



### 解决方案



**核心思路**：查看Docker已有网络并将其加入防火墙信任区



**执行命令：**



```Bash
docker network ls
firewall-cmd --permanent --zone=trusted --add-interface=br-{查到的nexent_network对应的Network ID}
```



**验证方法：**



```Bash
# 查看对应的network是否已经添加到信任区
firewall-cmd --zone=trusted --list-all

# 进入容器并尝试是否能curl通其他容器
docker exec -it nexent-config bash
curl nexent-runtime:5014
```



### 注意事项



- 对于自定义网络，你需要将它实际创建的接口（通常形如 `br-xxxxxxxxxxxx`）加入信任区，而不是直接使用网络名称。

## 5. Supabase容器启动失败，报错与ulimits相关

### 问题现象

**Supabase 相关容器**启动失败，容器日志报错与ulimits或者线程数量有关



### 问题原因

supabase相关容器启动时，尝试打开的文件描述符数量超过了系统当前允许的限制，导致启动失败。



### 解决方案



**核心思路**：修改docker-compose-supabase.yml，在kong服务的启动参数下添加ulimits参数。



**添加参数：**



```Bash
kong:
  container_name: suapabase-kong-mini
  images: xxx
  ports: xxx
  ...
  ulimits:
    nofile:
      soft: 65536
      hard: 65536
```



#### 注意事项



1. ulimits参数应该与其他的如image，ports等参数同级，放在对应服务名(kong)下



## 6. 部署langfuse监控时，clickhouse启动失败，报错cd: null directory

### 问题现象

**clickhouse 相关容器**启动失败，容器日志报错cd: null directory



### 问题原因

clickhouse官方镜像不兼容鲲鹏arm cpu，使用的命令部分指令集不支持，导致获取工作目录的环境变量会失败，需要重新构建镜像。



### 解决方案

使用以下clickhouse镜像

> 📎 **附件**：`clickhouse-server-kunpeng.tar`（约 391 MB，飞书附件 token：`Wksdb2sGOoUJkUxjhORcvJTenrh`，请从原文档下载）



### 注意事项

如果更换后还是无法启动，可参考<cite doc-id="IYhBwW2P9i51rZkLSIRcIZvNnoc" file-type="wiki" title="Nexent 平台部署常见问题排查与解决方案 (FAQ)" type="doc"></cite>添加`security_opt`参数。

## 修改 API Key 等环境变量后部署不生效

### 问题现象

修改 .env / compose 里的 key（如 AIDP API Key）后重新部署，容器仍用旧值，服务鉴权失败，表现为“部署失败”。

### 问题原因

docker compose 对已运行的容器默认不重建；只改环境变量、镜像和命令都没变时，`docker compose up -d` 不会 recreate。环境变量是容器创建时注入的，`docker restart` 也不刷新。

### 解决方案

对引用该变量的服务执行 `docker compose up -d --force-recreate <服务名>` 重建容器（必要时先 `docker rm` 再 up）。

### 注意事项

本仓库环境下 force-recreate 必须带 `-p nexent` 指定项目名（漏了会另起一套平行栈），且镜像名变量（NEXENT_IMAGE 等）不在 env/.env 里，要先 export 再执行。9/15 的 MINIO 桶名配置修复就是同款问题，改 .env 前先备份。

## 部署后容器反复重启、服务起不来

### 问题现象

config 等基础容器启动即退出、无限重启，服务起不来。

### 问题原因

宿主机资源不足，容器启动时无法分配资源或被 OOM kill，docker 按 restart 策略不停重试。

### 解决方案

用 `docker inspect <容器>` 看 OOMKilled 标志和退出码，`docker stats` / `free` 看资源余量；清理资源或调大配额后重建。

### 注意事项

遇到“一直重启”先定位退出原因，反复 down/up 会掩盖问题；生产实施前按部署清单核对宿主机资源是必要步骤。

## 知识库创建失败、存量库不显示——ES 磁盘水位线

### 问题现象

知识库创建失败，已存在的知识库/索引不显示。

### 问题原因

部署盘占用超过 95%，触发 Elasticsearch 的 flood-stage 磁盘危险水位线（默认 95%），索引被强制只读、写入相关服务停止。

### 解决方案

清理磁盘空间（日志、镜像、无用卷）降到 95% 以下，必要时解除索引只读块，再恢复 ES 及依赖服务。

### 注意事项

这是 ES 内置保护机制而非故障，不要靠调高水位线阈值“绕过”；生产部署应给 ES 独立磁盘并在 90% 左右设告警，接到“知识库批量异常”类反馈先查磁盘水位。

## 对话首 token 缓慢

### 问题现象

问答界面回复慢、首 token 延迟高；同一知识库在“工具测试”里响应正常。

### 问题原因

对话链路召回的知识条数过多导致上下文膨胀，模型处理耗时上升；工具测试返回量小，所以显不出问题。

### 解决方案

调低召回数量（topK）、启用 rerank 收敛送入模型的候选、控制引用内容长度。

### 注意事项

排障时先对比“工具直测”与“完整对话链路”的差异，能快速区分是召回量问题还是服务问题。

## 新建的空白智能体串用了别的智能体提示词

### 问题现象

未配置提示词的新 agent “默认”带上了另一个 agent 的提示词/配置。

### 问题原因

用户在智能体配置中编辑模型配置时触发了历史接口，产生一条废弃的租户级 app_config 记录；该租户级配置对租户内所有 agent 生效，覆盖了 agent 自身的提示词等初始配置。

### 解决方案

短期应急是清空租户信息库表中的 app_config 字段，即可恢复正常；代码层已在当前版本修复，升级后不会再触发。

### 注意事项

排查“agent 配置被覆盖/串用”类问题时，先查租户库表中是否存在废弃的 app_config 记录

## 模型偶发输出中断，输出包含不完整或错误的标签

### 问题现象

智能体回复偶发性异常：输出到一半就停止，或输出中包含不完整、错误的标签（标签只有开头没有闭合、被截断、拼错等）。多数对话正常，仅偶尔出现。

### 问题原因

模型没有完整遵从产品的输出约束。Nexent 按闭集标签协议解析模型输出：`<code>...</code>` 为可执行代码块、`<final_answer>...</final_answer>` 为最终答案信封、`<think>...</think>` 为思考内容。当输出中标签不配对、被截断或出现协议之外的标签时，对应的功能文本块无法被解析，触发协议校验失败并进入自动修复重试；重试耗尽后本轮回复终止。这是模型行为层面的偶发偏差，不是解析模块故障。

### 解决方案

无需现场修复：重新发起对话即可恢复。运行时已内置协议修复重试，会自动要求模型按约束重新输出；如偶发频率影响使用，可在智能体配置中更换输出遵循能力更强的模型。

### 注意事项

- 排查时先看后端日志的协议错误分类（malformed_action / unsupported_or_tag_only_output 等），确认是标签完整性问题，而不是网络中断或生成长度截断（finish_reason=length 属于截断，与本条不同因）；
- `<python_interpreter>` 并不是产品的解析标签：代码动作的协议标签是 `<code>`，`python_interpreter` 只是运行时把 `<code>` 动作包装成内部 ToolCall 使用的工具名（监控/链路追踪中可见），模型若直接输出该标签同样会被判为协议违规，不要据此误以为解析逻辑按工具名打标签。

## 模型调用报 zstd decompressor error: Unknown frame descriptor（DeepSeek 官方 / v2.4.0，2026-10-26 案例）

### 问题现象

对话时报：

```text
Error in generating model output: zstd decompressor error: Unknown frame descriptor
```

模型为 DeepSeek 官方（`base_url=https://api.deepseek.com`），现场版本 v2.4.0（个人环境）。报错不一定每次必现，正常对话可能成功，偶发在模型响应或错误响应路径出现。

### 问题原因

v2.4.0 的模型调用走 OpenAI SDK → `httpx 0.28.x`。httpx 在运行环境可导入 `zstandard` 时，默认发送 `Accept-Encoding: gzip, deflate, zstd`，并对 `Content-Encoding: zstd` 的响应强制解压。`zstandard` 不是 Nexent 的直接依赖，而是 `langchain → langchain-core → langsmith → zstandard` 带进镜像的传递依赖，所以官方镜像天然具备 zstd 解压能力。

DeepSeek 官方接口确实会返回 `Content-Encoding: zstd`，正常情况下 httpx 能正确解压。`Unknown frame descriptor` 的真实含义是：**响应头声明 zstd，但响应体第一批字节不是合法 zstd 帧**（典型为边缘错误页、代理改写、流损坏），真实的上游 HTTP 错误因此被掩盖。这不是 Nexent 业务逻辑 bug，也不是 zstd 流截断（截断会报 `Zstandard data is incomplete`）。

v2.8.0 已升级到 `openai 3.x + httpx2`：Python 3.11 下 httpx2 只认 `backports.zstd`（镜像默认未安装），默认头变为 `gzip, deflate`，DeepSeek 返回 gzip，主链路不再触发该错误。

### 解决方案

1. **推荐**：升级到 v2.8.0 及以上；主链路不再协商 zstd。验证：

   ```bash
   docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import openai, httpx2; from httpx2._client import ACCEPT_ENCODING; print(openai.__version__, httpx2.__version__, ACCEPT_ENCODING)"
   ```
2. **v2.4.0～v2.7.x 临时热修复**：在 `nexent-runtime` 容器内把 zstd 从 httpx 的解码器注册表移除：

   ```bash
   F=$(docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import httpx._decoders as d; print(d.__file__)" | tr -d '\r')
   docker exec nexent-runtime cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"
   docker exec nexent-runtime bash -c "grep -q 'NEXENT HOTFIX: disable zstd' '$F' || printf '\n# NEXENT HOTFIX: disable zstd content-encoding\nSUPPORTED_DECODERS.pop(\"zstd\", None)\n' >> '$F'"
   docker exec nexent-runtime /opt/backend/.venv/bin/python -m py_compile "$F" && echo SYNTAX_OK
   docker restart nexent-runtime
   docker exec nexent-runtime /opt/backend/.venv/bin/python -c "from httpx._client import ACCEPT_ENCODING; print(ACCEPT_ENCODING)"
   ```
3. **v2.8.0 仍出现时**：说明 `httpx2` 的 zstd 被重新启用（安装了 `httpx2[zstd]`/`backports.zstd`，或 Python 3.14+ 启用标准库 zstd），把同样的 `SUPPORTED_DECODERS.pop("zstd", None)` 追加到 `httpx2/_decoders.py` 后重启。

### 注意事项

- 先区分错误类型：`Unknown frame descriptor` 是“头体不一致”；`Zstandard data is incomplete` 才是流被截断。前者优先查模型服务/代理/网关，后者查网络中断或流式连接。
- 补丁后如果出现 401/403/429/5xx 或 JSON 解析失败，说明真实上游错误暴露出来了，按真实 HTTP 错误继续排查（鉴权、配额、网关），不要回滚。
- 热修复只改容器可写层，`--force-recreate`、镜像升级、删容器都会丢失；长期方案是升级到 2.8.0，或用派生镜像固化补丁。
- 不要通过卸载 `zstandard` 包来规避：`langsmith` 依赖它，移除可能影响 LangChain/LangSmith tracing；优先用上面的 httpx 解码器补丁。

> **补充（2026-10-26，v2.4.1 镜像实测）**：镜像 tag 为 v2.4.1 时，`/opt/nexent/VERSION` 仍显示 v2.4.0，但构建时可能已解析到 `openai 3.x`，模型调用实际走 **httpx2**。判断方法：`openai.OpenAI(...)._client` 的 MRO 含 `httpx2.Client` 就补 `httpx2/_decoders.py`，含 `httpx.Client` 才补 `httpx/_decoders.py`。只补 httpx 时，`httpx` 的 `ACCEPT_ENCODING` 会变成 `gzip, deflate`，但 OpenAI 客户端仍可能发送 `zstd`；务必用 `c._client.headers.get('accept-encoding')` 复核。

> **现场结果（2026-10-26）**：v2.4.1 环境按上述判断执行，补 `httpx2/_decoders.py` 后 `openai.OpenAI(...)._client.headers['accept-encoding']` 不再含 `zstd`，DeepSeek 对话恢复正常。

## 北向接口下载智能体生成的文件——presigned_url 透传（v2.6.1 案例 2026-10-26）

### 问题现象

外部系统通过北向 API 调用智能体后，需要下载智能体生成的文件（Word/Excel/PDF 等），不清楚北向是否提供下载接口。

### 问题原因

生成文件（Skill 产物/工作区产物）先上传到 MinIO；北向对话接口不直接返回文件字节，而是在运行流结束前下发 `files` 事件，`file_uploads[].presigned_url` 已拼好北向代理下载地址（`/nb/v1/file/fetch?presigned_url=...`），透传该地址即可下载。

### 解决方案

1. 持续读取 `POST /nb/v1/chat/run` 的 SSE 到流结束；
2. 解析 `type=files` 的事件；注意 `content` 是 JSON 字符串，需要二次解析：

   ```json
   {"type":"files","content":"{\"file_uploads\":[{\"file_name\":\"xxx.docx\",\"object_name\":\"skill-files/...\",\"presigned_url\":\"http://<外部地址>/api/nb/v1/file/fetch?presigned_url=...\"}]}"}
   ```
3. 直接 GET `file_uploads[].presigned_url` 下载，无需再带 Bearer Token；
4. 事后也可通过 `GET /nb/v1/conversations/{conversation_id}` 的 `minio_files` 获取同样的文件信息。

### 注意事项

- `presigned_url` 内嵌的 MinIO 签名默认有效期 24 小时（86400 秒），过期后 2.6.1 北向没有仅凭 `object_name` 重新签发的通用接口（`/nb/v1/knowledge/file/download/{object_name}` 仅资产管理员租户可用），需平台侧重新签发或重新生成；
- 部署需正确配置 `NORTHBOUND_EXTERNAL_URL` 为外部可访问地址（如 `http://<IP>:5013/api`），否则返回链接指向 `localhost:5013` 无法使用；
- `files` 事件只在确实产生生成文件时出现，且在流末尾下发，客户端需读到流结束，不能中途断开。

<!-- ===== 本地沉淀区（同步保留，勿删） ===== -->
<!-- 说明：此标记以下内容由本地沉淀（支撑流程⑦闭环）追加；每日同步只更新标记以上的远端内容，此区域原样保留。若某条沉淀已推回飞书 wiki，请从下方删除对应条目。 -->

## 知识库入库失败——ES 90% 高水位阶段 503 伪装成"超时"（60 环境案例 2026-10-20）

### 问题现象

data_process 容器日志 forward 任务报 `ElasticSearch service returned HTTP 500`（error_code 990104=SYSTEM_TIMEOUT），前端呈现"入库失败"；nexent-config 容器日志同期大量 `ApiError(503, 'search_phase_execution_exception')` 与 `Node <http://nexent-elasticsearch:9200> has failed for N times in a row`，并可能伴随一批存量索引 404（index_not_found_exception）刷屏。此时部署盘通常还不到 95%。

### 问题原因

ES 数据盘使用率超过 90% high watermark（ES 日志 DiskThresholdMonitor 报 "high disk watermark [90%] exceeded"），单节点集群 shard 无处可迁，读写请求被拒/超时。写 ES 请求实际经 nexent-config 代理（`ELASTICSEARCH_SERVICE=http://nexent-config:5010/api` → `apps/vectordatabase_app.py`），config 把异常兜底为 HTTP 500，data_process 按"timed out"关键字打 990104，表象像"超时/服务内部错误"。与第 9 条"95% flood_stage 索引只读"是同一磁盘问题的两个阶段：**90% 高水位阶段即可导致入库失败，不必等到 95%**。

### 解决方案

1. `df -h` 确认磁盘水位；`docker system prune -f`、清理服务日志（`~/nexent/logs/`）、删除"数据库有记录但 ES 已 404"的残留知识库，降至 90% 以下；
2. 曾撞 95% 被只读的索引需解除只读块：`curl -u elastic:<ELASTIC_PASSWORD> -XPUT "http://localhost:9210/_all/_settings" -H 'Content-Type: application/json' -d '{"index.blocks.read_only_allow_delete": null}'`；
3. 不要调高水位线阈值绕过；生产 ES 数据目录独立磁盘 + 90% 告警。

### 注意事项

- 入库失败不要只盯 data-process 日志：500 是 nexent-config 代理接口兜底的，根因要看 **nexent-config** 与 **nexent-elasticsearch** 同时间点日志；
- 990104=SYSTEM_TIMEOUT 是按错误消息含 "timed out" 分类打的码，磁盘水位问题会伪装成"超时"；看到 `search_phase_execution_exception` + 节点连续失败 + 磁盘水位告警三件套即可定性环境事件；
- 大量 `index_not_found` 404 说明数据库登记与 ES 索引脱节（数据卷曾丢失/重建），恢复磁盘后还需清理残留库记录，否则知识库页面持续报错。

## 深度思考模型 reasoning-only 输出导致正文为空（空响应/动作不完整/请求无效三连报错）——2026-10-20 案例

### 问题现象

智能体对话中思考型模型开启深度思考时偶发三类报错连发：①「模型连续返回空响应，请稍后重试」；②步骤警告「The previous response described an action but ended before producing an executable tool call...」（动作不完整）；③后续步骤「模型请求无效，无法重试」（运行终止）。共同特征：模型思考内容（reasoning_content）正常输出，正文 content 为空或只有动作前导词；关闭模型深度思考后现象大幅缓解（现场已验证）。

### 问题原因

深度思考模式下模型输出预算（max_tokens）计数包含思考内容：思考耗尽预算后正文一个字未输出即被截断（finish_reason=length，SDK 诊断字段 reasoning_only_budget_exhausted 即为此场景）；部分思考型模型存在"思考即答案"退化行为——结论写入思考通道后正文省略。Agent 侧 ReAct 链路只以正文 content 为有效输出（`sdk/nexent/core/models/openai_llm.py` 仅拼接 delta.content，reasoning_content 只流向思考展示），空响应判定不区分"完全空"与"仅缺正文"；且 finish_reason=length 时空响应不重试直接终态（`openai_llm.py` 重试条件仅接受 None/stop），对思考长度的随机性没有容错。正文截断/前导词再触发"动作不完整"步骤错误，纠错文本追加进上下文后，下一步请求可能被模型服务以 400/422 拒绝（呈现为"模型请求无效"，快速失败不重试）。

### 解决方案

1. 短期规避（现场已验证有效）：关闭该模型深度思考或调低思考档位；条件允许时简单问答与 ReAct 执行分模型配置；
2. 调大模型记录的 max_tokens：按"峰值思考长度 + 正文长度"评估输出预算，直接对冲 reasoning_only_budget_exhausted；
3. ReAct 智能体系统提示词显式约束："思考仅写入思考通道，正文必须输出完整动作或最终答案，禁止正文为空"；
4. 产品优化已提问题单（修改人：王靖泷），方向：reasoning-only 专项修复重试、思考档位联动降档、空响应错误文案细化（区分"完全空"与"仅输出思考"）。

### 注意事项

- 排查取证看后台日志 `event=empty_model_response` 一行的 finish_reason 与 reasoning_char_count：length + reasoning>0 + content=0 即坐实本条；
- "模型连续返回空响应"在该场景多数由 finish_reason=length 直接触发（不重试），与"重试 5 次全空"是不同分支，定性时别混淆；
- 三类报错出现在同一次运行时，按一条根因处理，不要按三个独立问题分头排查。
