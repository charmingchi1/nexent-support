# 容器内热修复 SOP（Python 后端，docker compose 部署）

> 适用：显式 bug 已定位到容器内某个 Python 文件的一处改动、等不及官方版本时的**临时规避**；或用户明确要求「热修复 / hotfix / 在容器里改」。
> 正式修复仍走⑤升级 + ⑥登记（双确认），官方修复合入后正常升级即替代热修，无需回滚。
> 实测案例（换修复点时只替换第 2 步的 sed 模式，其余框架不变）：
> - 《D:\projects\feishu\docs\热修复指南-A2A-ssl_verify-v2.6.1.md》
> - 《D:\projects\feishu\docs\热修复指南-zstd-Accept-Encoding-v2.4.0.md》

## 关键事实（2026-10-19 核实，develop 与 v2.6.1 一致）

- 部署形态：docker compose，所有后端服务共用 `${NEXENT_IMAGE}`（main 镜像），代码**镜像内置**（backend 目录无卷挂载），热修=改容器可写层。
- main 镜像：`WORKDIR /opt`，后端代码在 `/opt/backend/`，venv 在 `/opt/backend/.venv`，启动脚本 `/opt/nexent/scripts/start-backend.sh`（仅等 SQL + exec，不改目录）。
- 服务 → 容器 → 入口（compose 文件在代码仓 `deploy/docker/compose/docker-compose.yml`）：
  - `nexent-mcp` 服务 → 容器 `nexent-mcp`（5011/5015）→ `python backend/mcp_service.py` → **/opt/backend/mcp_service.py**
  - 同类：`nexent-config`（runtime_service.py）、`nexent-runtime`（runtime_service.py）、`nexent-northbound`（5013）。改哪个服务就重启哪个容器，**不连坐**。
- **懒加载**：MCP 工具按租户懒注册——`nexent-mcp` 重启后，租户首个 MCP 请求自动从 DB 重建全部 OpenAPI 转换工具，无需手动调 `/tools/openapi_service/refresh`。
- 热修只存在容器可写层：`docker compose -p nexent up -d --force-recreate`、镜像升级、删容器都会丢（FAQ 第 7 条：force-recreate 必须带 `-p nexent`）。

## 标准步骤（以「API 转 MCP 工具 ssl_verify」修复为实例）

**0 前置确认**（行号/行为与预期不符就停，勿盲改）：
```bash
docker ps | grep nexent-mcp
docker exec nexent-mcp ls -l /opt/backend/mcp_service.py
docker exec nexent-mcp grep -n "httpx.AsyncClient(base_url=server_url" /opt/backend/mcp_service.py
```

**1 备份**（容器内+宿主机双份；.bak 后缀不会被 import，安全）：
```bash
D=$(date +%Y%m%d-%H%M%S)
docker exec nexent-mcp cp /opt/backend/mcp_service.py /opt/backend/mcp_service.py.bak-$D
docker cp nexent-mcp:/opt/backend/mcp_service.py ~/mcp_service.py.bak-$D
docker exec nexent-mcp md5sum /opt/backend/mcp_service.py*   # 两备份 md5 应一致
```

**2 修改**（一行 sed；本例：register_openapi_service 的 AsyncClient 加 verify=False，v2.6.1 该行在 239 行）：
```bash
docker exec nexent-mcp sed -i 's|client = httpx.AsyncClient(base_url=server_url, timeout=120.0, headers=headers_template)|client = httpx.AsyncClient(base_url=server_url, timeout=120.0, headers=headers_template, verify=False)|' /opt/backend/mcp_service.py
docker exec nexent-mcp grep -n "verify=False" /opt/backend/mcp_service.py
docker exec nexent-mcp python -m py_compile /opt/backend/mcp_service.py && echo SYNTAX_OK
```
若 grep 到的实际行文本与 sed 模式不符（版本差异）：以实际为准改模式，或 `docker cp` 出来手改再拷回。

**3 重启**（只重启目标容器）：
```bash
docker restart nexent-mcp
docker logs -f --tail 50 nexent-mcp
```

**4 验证**：让用户重新调用出问题的功能（如智能体调用 API 转换工具），预期不再报 SSL: CERTIFICATE_VERIFY_FAILED；失败看 `docker logs --tail 100 nexent-mcp`（若换报证书链不完整等其他 TLS 错，转「装自签根证书」路线：追加进容器内 certifi cacert.pem，`python -c "import certifi; print(certifi.where())"`）。

**5 回滚**：
```bash
docker exec nexent-mcp cp /opt/backend/mcp_service.py.bak-$D /opt/backend/mcp_service.py && docker restart nexent-mcp
# 容器已损坏时用宿主机备份：
docker cp ~/mcp_service.py.bak-$D nexent-mcp:/opt/backend/mcp_service.py && docker restart nexent-mcp
```

## 边界与告知义务

- 一次热修只改一个文件、重启一个容器；数据库无变更，回滚零副作用。
- 若改动涉及关闭证书校验（verify=False）等安全项：仅影响对应出站 HTTPS，内网自签场景与平台现状一致（MCP 连接层本就 verify=False），但**有中间人风险，必须在答复话术/问题单中注明**。
- 热修随 `--force-recreate`（必须带 `-p nexent`）、镜像升级、删容器丢失；答复中告知用户官方版本发布后升级替代，热修即作废。
