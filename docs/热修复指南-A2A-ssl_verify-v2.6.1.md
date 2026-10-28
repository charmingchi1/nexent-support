# A2A ssl_verify 热修复操作指南（v2.6.1 实测版 · 单行命令 · 固定路径）

> 适用问题：A2A 配置外部协作智能体时 SSL 证书校验强制开启且无配置项，对端为自签名/内部 CA 证书时报
> `SSL: CERTIFICATE_VERIFY_FAILED`，添加智能体与对话调用均失败。
> 已登记问题跟踪表：reczz28PzSEv1hq2（责任模块 智能体配置，预期修改版本 Nexent 1030）。本热修复为临时手段。
> **升级迁移**：v2.8.0/1030 已提供 per-agent 开关，升级后的存量 Agent 数据迁移见《A2A-证书校验开关-迁移指南.md》。
> 全部为**单行命令**，无循环、无 heredoc，逐条粘贴执行。
>
> **使用说明**：runtime 的文件路径含 Python 版本号段 `python3.XX`（XX 因镜像而异）。先执行步骤 0 查出实际版本（如 python3.11），**把本指南所有 `python3.XX` 全局替换为实际值**再执行；config 侧路径固定无需替换。

## 修改哪里

- ● 容器：`nexent-config`（A2A 发现/刷新卡片/管理侧调用的执行体，端口 5010）
- ● 文件：`/opt/backend/utils/a2a_http_client.py`（代码镜像内置、无卷挂载，必须改容器内文件）
- ● 改动：`A2AHttpClient.__aenter__` 的 `aiohttp.TCPConnector(` 块加 `ssl=False`（v2.6.1 锚点在第 50 行 `enable_cleanup_closed=True,`）
- ● 容器：`nexent-runtime`（对话运行时调用协作智能体的执行体，端口 5014）
- ● 文件：`/opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py`（SDK 经 `uv pip install --link-mode copy` 拷贝安装，改 `/opt/sdk` 源码无效，必须改 site-packages；`python3.XX` 见步骤 0）
- ● 改动：`httpx.AsyncClient(...)` 加 `verify=False`（锚点 `follow_redirects=True,`）

> v2.6.1 与 develop 差异：develop 的 `backend/infrastructure/http/a2a.py` 在 2.6.1 **不存在**，后端客户端在 `utils/a2a_http_client.py`；该客户端仅被 `services/a2a_client_service.py` 引用且只挂在 config 服务，runtime 无引用 → 每容器只改 1 个文件。SDK 代理文件与 develop 代码一致。

## 完整流程（按序执行，一行一回车）

### 0 前置确认——grep 无输出说明现场代码与预期不符，停手转研发，勿盲改

```bash
docker ps | grep -E "nexent-(config|runtime)"
```
（两容器均 Up 才继续）

```bash
docker exec nexent-runtime ls /opt/backend/.venv/lib/
```
（输出形如 `python3.11`，**记下它，全局替换本文所有 `python3.XX`**）

```bash
docker exec nexent-runtime ls -l /opt/backend/.venv/bin/python
```
（存在才继续，后面 py_compile 用它）

```bash
docker exec nexent-config ls -l /opt/backend/utils/a2a_http_client.py
```
```bash
docker exec nexent-config grep -n "enable_cleanup_closed=True," /opt/backend/utils/a2a_http_client.py
```
```bash
docker exec nexent-runtime ls -l /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py
```
```bash
docker exec nexent-runtime grep -n "follow_redirects=True," /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py
```
（两条 grep 各输出 1 行锚点；无输出停手反馈）

### 1 备份——容器内+宿主机双份，md5 校验一致（.bak-$D 后缀不会被 Python import，留容器内安全）

```bash
D=$(date +%Y%m%d-%H%M%S)
```
```bash
docker exec nexent-config cp /opt/backend/utils/a2a_http_client.py /opt/backend/utils/a2a_http_client.py.bak-$D
```
```bash
docker cp nexent-config:/opt/backend/utils/a2a_http_client.py ~/a2a_http_client.py.bak-$D
```
```bash
docker exec nexent-runtime cp /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py.bak-$D
```
```bash
docker cp nexent-runtime:/opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py ~/a2a_agent_proxy.py.bak-$D
```
```bash
docker exec nexent-config md5sum /opt/backend/utils/a2a_http_client.py /opt/backend/utils/a2a_http_client.py.bak-$D
```
```bash
docker exec nexent-runtime md5sum /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py.bak-$D
```
```bash
md5sum ~/a2a_http_client.py.bak-$D ~/a2a_agent_proxy.py.bak-$D
```
容器内与宿主机的 .bak-$D md5 应一致。

### 2 修改——两条 sed（幂等 guard，重复执行自动跳过），改完 grep 确认 + py_compile 语法校验

```bash
docker exec nexent-config bash -c 'grep -q "ssl=False" /opt/backend/utils/a2a_http_client.py || sed -i "s|enable_cleanup_closed=True,|enable_cleanup_closed=True,\n            ssl=False,|" /opt/backend/utils/a2a_http_client.py'
```
```bash
docker exec nexent-config grep -n "ssl=False" /opt/backend/utils/a2a_http_client.py
```
```bash
docker exec nexent-config /opt/backend/.venv/bin/python -m py_compile /opt/backend/utils/a2a_http_client.py && echo SYNTAX_OK
```
```bash
docker exec nexent-runtime bash -c 'grep -q "verify=False" /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py || sed -i "s|follow_redirects=True,|follow_redirects=True,\n            verify=False,|" /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py'
```
```bash
docker exec nexent-runtime grep -n "verify=False" /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py
```
```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -m py_compile /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py && echo SYNTAX_OK
```
两条 SYNTAX_OK 必须出现，否则停手走回滚。清字节码缓存（自动重建）：
```bash
docker exec nexent-config rm -rf /opt/backend/utils/__pycache__
```
```bash
docker exec nexent-runtime rm -rf /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/__pycache__
```

### 3 重启——只重启这两个容器，其他容器不动

```bash
docker restart nexent-config nexent-runtime
```
```bash
docker logs -f --tail 50 nexent-config
```
（Ctrl+C 退出跟踪，runtime 同理）

生效机制：`A2AHttpClient` 是每次请求即用即建的会话（发现/刷新卡片/管理侧测试调用都是 `async with` 临时创建），config 重启后第一个请求就用新代码，无缓存、无需调 refresh；runtime 侧智能体每次运行时按数据库配置重建协作智能体代理并新建 httpx client，重启后首个对话即生效。想立即确认可在前端重新保存一次该协作智能体触发卡片刷新。

### 4 验证

- 页面用原报错的 https 自签地址添加/发现协作智能体 → 成功抓到 Agent Card（config 侧生效）；
- 对话中让主智能体调用该协作智能体 → 正常返回（runtime 侧生效）；
- 日志复核（应为 0；config 侧 aiohttp 对连接类错误有 3 次重试，修复前失败会连报 3 次）：

```bash
docker logs --since 10m nexent-config 2>&1 | grep -c "CERTIFICATE_VERIFY_FAILED"
```
```bash
docker logs --since 10m nexent-runtime 2>&1 | grep -c "CERTIFICATE_VERIFY_FAILED"
```

若打补丁后仍报 `CERTIFICATE_VERIFY_FAILED` → 检查是否改错容器/没重启/另有调用路径，把日志反馈定位；若变成全新报错（超时/连接拒绝）→ 网络连通性问题，转网络排查。

### 5 回滚（出问题时）

```bash
docker exec nexent-config cp /opt/backend/utils/a2a_http_client.py.bak-$D /opt/backend/utils/a2a_http_client.py && docker restart nexent-config
```
```bash
docker exec nexent-runtime cp /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py.bak-$D /opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py && docker restart nexent-runtime
```
容器已改坏时，用宿主机备份覆盖：
```bash
docker cp ~/a2a_http_client.py.bak-$D nexent-config:/opt/backend/utils/a2a_http_client.py && docker restart nexent-config
```
```bash
docker cp ~/a2a_agent_proxy.py.bak-$D nexent-runtime:/opt/backend/.venv/lib/python3.XX/site-packages/nexent/core/agents/a2a_agent_proxy.py && docker restart nexent-runtime
```
回滚零副作用：补丁只动代码文件，数据库无任何变更，回滚后行为恢复原状（自签场景重新报 CERTIFICATE_VERIFY_FAILED 属预期）。

## 两个必须知道的边界

1. 热修复只存在容器可写层：`--force-recreate`（注意带 `-p nexent`）、镜像升级、删容器都会丢。官方 ssl_verify 配置化修复合入后正常升级即自然替代，升级前无需处理（跟踪单 reczz28PzSEv1hq2，Nexent 1030）。
2. `ssl=False`/`verify=False` 的影响范围：config 侧为 A2A 发现/卡片刷新/管理侧测试调用的出站 HTTPS，runtime 侧为对话中调用协作智能体的出站 HTTPS，存在中间人风险；内网自签场景需局点负责人确认后使用。更合规替代：局点有对端 CA 证书文件时，走"导入信任库 + SSL_CERT_FILE 挂载重建"，不关校验、无代码改动。
