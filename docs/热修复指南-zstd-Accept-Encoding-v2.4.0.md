# Nexent zstd `Unknown frame descriptor` 容器热修复指南

> 适用问题：对话时报
> `Error in generating model output: zstd decompressor error: Unknown frame descriptor`
> 典型环境：Nexent v2.4.0～v2.7.x（OpenAI SDK 仍使用 `httpx 0.28.x`），模型为 DeepSeek 官方或其它支持 `Content-Encoding: zstd` 的服务。
> 本热修复为**临时手段**，只改容器内文件，不改数据库，不卸载依赖包。
> 补丁对象以 **0.2.1 的实际客户端判断**为准：OpenAI 客户端 MRO 是 `httpx.Client` 就补 `httpx`，是 `httpx2.Client` 就补 `httpx2`；不要只看镜像版本号（v2.4.1 镜像可能已经是 openai 3.x + httpx2）。
>
> **Windows Git Bash 注意**：容器内绝对路径可能被改写成 `D:/...`。先执行一次
> `export MSYS_NO_PATHCONV=1`，再执行下面的命令；Linux 环境可忽略。
>
> **执行方式**：建议在同一个 shell 会话中按顺序执行，变量 `D`、`HTTPX_DEC`、`HTTPX_DIR` 会被后续步骤复用；如果中途换了终端，需要重新执行第 0.4 步和第 1 步开头的变量赋值。

---

## 0. 先判断是否真的需要这个热修复

### 0.1 确认容器和版本

```bash
docker ps | grep -E "nexent-(runtime|config)"
```

```bash
docker exec nexent-runtime cat /opt/nexent/VERSION
```

- 如果是 **v2.8.0 及以上**：主链路已换成 `openai 3.x + httpx2`，默认不协商 zstd，通常**不需要**本热修复。先按 0.2 确认；只有 `Accept-Encoding` 里仍出现 `zstd` 时才继续。
- 如果是 **v2.4.0～v2.7.x**：继续。

### 0.2 确认 zstd 解压路径确实被激活

先按实际版本选择检查命令。

**v2.4.0～v2.7.x（httpx 路径）**：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import zstandard, httpx; from httpx._client import ACCEPT_ENCODING; print('zstandard=', zstandard.__version__); print('httpx=', httpx.__version__); print('AE=', ACCEPT_ENCODING)"
```

预期（有问题时，版本号以现场为准，关键是 `AE` 里出现 `zstd`）：

```text
zstandard= 0.25.0
httpx= 0.28.1
AE= gzip, deflate, zstd
```

`zstandard` 导入失败或 `AE` 中没有 `zstd` → 说明现场代码/依赖与预期不符，**停手反馈**，不要盲改。

**v2.8.0 及以上（httpx2 路径）**：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import openai, httpx2; from httpx2._client import ACCEPT_ENCODING; print('openai=', openai.__version__); print('httpx2=', httpx2.__version__); print('AE=', ACCEPT_ENCODING)"
```

预期（正常，不需要热修复）：

```text
openai= 3.35.1
httpx2= 2.16.0
AE= gzip, deflate
```

如果 `AE` 含 `zstd`（例如装了 `httpx2[zstd]`/`backports.zstd`，或 Python 3.14+ 启用了标准库 zstd），本指南的补丁对象要换成 `httpx2/_decoders.py`，其余备份、校验、重启、回滚流程完全相同。

### 0.2.1 关键：确认 OpenAI 客户端实际使用的 HTTP 库（v2.4.1 镜像必做）

上面按版本判断可能不够准确：v2.4.1 镜像虽然 `/opt/nexent/VERSION` 显示 v2.4.0，但构建时可能已解析到 `openai 3.x`，模型调用实际走 `httpx2`，不是 `httpx`。此时只补 `httpx` 会看到 `httpx` 的 `ACCEPT_ENCODING` 已变成 `gzip, deflate`，但 OpenAI 客户端仍发送 `zstd`。

先用下面这条命令看实际客户端：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import openai, inspect; c=openai.OpenAI(api_key='sk-test-not-real', base_url='https://api.deepseek.com'); print('openai=', openai.__version__); print('mro=', [f'{x.__module__}.{x.__name__}' for x in type(c._client).__mro__]); print('file=', inspect.getfile(type(c._client))); print('headers=', dict(c._client.headers))"
```

- 输出 MRO 含 `httpx2.Client` → 模型调用走 httpx2，补丁对象是 `httpx2/_decoders.py`，按下面 0.2.2 执行。
- 输出 MRO 含 `httpx.Client` → 补丁对象是 `httpx/_decoders.py`，按 0.4 取的路径执行；如果 `httpx` 的 `ACCEPT_ENCODING` 已不含 zstd 但客户端仍含，说明 openai 用的是另一份 vendored/独立 httpx，按 `file=` 输出的路径单独打补丁。

确认 httpx2 的当前状态：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import httpx2; from httpx2._client import ACCEPT_ENCODING; from httpx2._decoders import SUPPORTED_DECODERS; print('httpx2=', httpx2.__version__); print('AE=', ACCEPT_ENCODING); print('decoders=', sorted(SUPPORTED_DECODERS))"
```

### 0.2.2 补丁 httpx2（仅当 0.2.1 判定为 httpx2）

```bash
HTTPX2_DEC=$(docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import httpx2._decoders as d; print(d.__file__)" | tr -d '\r')
echo "$HTTPX2_DEC"
docker exec nexent-runtime cp "$HTTPX2_DEC" "$HTTPX2_DEC.bak-$(date +%Y%m%d-%H%M%S)"
docker exec nexent-runtime bash -c "grep -q 'NEXENT HOTFIX: disable zstd' '$HTTPX2_DEC' || printf '\n# NEXENT HOTFIX: disable zstd content-encoding\nSUPPORTED_DECODERS.pop(\"zstd\", None)\n' >> '$HTTPX2_DEC'"
docker exec nexent-runtime /opt/backend/.venv/bin/python -m py_compile "$HTTPX2_DEC" && echo SYNTAX_OK
docker restart nexent-runtime
```

验证（两条都不应含 zstd）：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "from httpx2._client import ACCEPT_ENCODING; print(ACCEPT_ENCODING)"
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import openai; c=openai.OpenAI(api_key='sk-test-not-real', base_url='https://api.deepseek.com'); print('accept-encoding:', c._client.headers.get('accept-encoding'))"
```

如果 MRO 指向的是 openai 自带的 vendored httpx/httpx2，把上面的 `httpx2._decoders` 换成 `inspect.getfile(type(c._client))` 所在包的 `_decoders` 路径。

### 0.3 确认日志里有目标报错

```bash
docker logs --since 24h nexent-runtime 2>&1 | grep -n -m 3 "Unknown frame descriptor"
```

没有输出也可能是日志已滚动；只要 0.2 的输出包含 `zstd`，仍可继续。

### 0.4 查出运行时真正加载的 httpx 文件

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import httpx._decoders as d; print(d.__file__)"
```

记下输出，例如：

```text
/opt/backend/.venv/lib/python3.11/site-packages/httpx/_decoders.py
```

后续用变量保存（`tr -d '\r'` 用于兼容 Windows 换行）：

```bash
HTTPX_DEC=$(docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import httpx._decoders as d; print(d.__file__)" | tr -d '\r')
echo "$HTTPX_DEC"
```

> v2.8.0+ 且 0.2 判定需要处理 httpx2 时，把上面的 `httpx._decoders` 换成 `httpx2._decoders`。

> SDK 是通过 `uv pip install --link-mode copy` 安装到 site-packages 的，改 `/opt/sdk` 源码**无效**，必须改上面这个实际加载的文件。

---

## 1. 备份（容器内 + 宿主机双份）

```bash
D=$(date +%Y%m%d-%H%M%S)
```

```bash
docker exec nexent-runtime cp "$HTTPX_DEC" "$HTTPX_DEC.bak-$D"
```

```bash
docker cp "nexent-runtime:$HTTPX_DEC" ~/httpx_decoders.py.bak-$D
```

```bash
docker exec nexent-runtime md5sum "$HTTPX_DEC" "$HTTPX_DEC.bak-$D"
```

```bash
md5sum ~/httpx_decoders.py.bak-$D
```

容器内原文件、容器内备份、宿主机备份三者的 md5 应一致。

---

## 2. 打补丁（单行命令，幂等）

作用：在 httpx 的 `_decoders.py` 末尾追加一行，把 `zstd` 从 `SUPPORTED_DECODERS` 中移除。这样 httpx 不再发送 `Accept-Encoding: zstd`，也不会尝试用 zstd 解压响应。

```bash
docker exec nexent-runtime bash -c "grep -q 'NEXENT HOTFIX: disable zstd' '$HTTPX_DEC' || printf '\n# NEXENT HOTFIX: disable zstd content-encoding\nSUPPORTED_DECODERS.pop(\"zstd\", None)\n' >> '$HTTPX_DEC'"
```

确认补丁已写入：

```bash
docker exec nexent-runtime tail -4 "$HTTPX_DEC"
```

预期末尾出现：

```text
# NEXENT HOTFIX: disable zstd content-encoding
SUPPORTED_DECODERS.pop("zstd", None)
```

语法校验：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -m py_compile "$HTTPX_DEC" && echo SYNTAX_OK
```

必须输出 `SYNTAX_OK`；否则立即走第 5 步回滚。

清理字节码缓存（可选，但建议）：

```bash
HTTPX_DIR=$(dirname "$HTTPX_DEC")
docker exec nexent-runtime rm -rf "$HTTPX_DIR/__pycache__"
```

> 如果提示 `Permission denied`，在 `docker exec` 后加 `-u root`。

---

## 3. 重启

只重启需要生效的容器。智能体对话报错只需要 `nexent-runtime`：

```bash
docker restart nexent-runtime
```

如果 UI 里的“模型连通性测试”也报同样的 zstd 错误，再把 `nexent-config` 用同样步骤打一遍并重启。操作时把前面所有命令中的 `nexent-runtime` 替换为 `nexent-config`，并重新执行 0.4 计算该容器内的 `HTTPX_DEC`：

```bash
docker restart nexent-config
```

> `nexent-mcp`、`nexent-northbound` 只有在它们也直接调用模型并出现同样报错时才需要处理；`nexent-web` 是前端/nginx，没有 Python 运行时，不要改。

看启动日志：

```bash
docker logs -f --tail 50 nexent-runtime
```

（Ctrl+C 退出跟踪）

---

## 4. 验证

### 4.1 确认 zstd 已从协商头中消失

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "from httpx._client import ACCEPT_ENCODING; print(ACCEPT_ENCODING)"
```

预期（没有 zstd）：

```text
gzip, deflate
```

如果装了 brotli，可能是：

```text
gzip, deflate, br
```

只要**不含 `zstd`** 即通过。

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "from httpx._decoders import SUPPORTED_DECODERS; print(sorted(SUPPORTED_DECODERS))"
```

预期不含 `'zstd'`。

再直接看模型客户端最终会用的头（不会发请求，不需要真实 Key）：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import openai; c=openai.OpenAI(api_key='sk-test-not-real', base_url='https://api.deepseek.com'); print('accept-encoding:', c._client.headers.get('accept-encoding'))"
```

预期输出 `accept-encoding: gzip, deflate`，不含 `zstd`。

### 4.2 离线复现检查（最直接）

补丁前会抛 `DecodingError`，补丁后应正常返回明文：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import httpx; r=httpx.Response(200, headers={'Content-Encoding':'zstd'}, content=b'{\"error\":\"plain\"}'); print(r.content)"
```

补丁后预期输出：

```text
b'{"error":"plain"}'
```

### 4.3 业务验证

- 在前端用原报错的智能体/模型（DeepSeek 官方）发一条消息，确认能正常返回。
- 检查运行时日志中不再出现目标报错：

```bash
docker logs --since 10m nexent-runtime 2>&1 | grep -c "Unknown frame descriptor"
```

预期输出 `0`。

- 查看模型调用日志（如果挂载了 `/mnt/nexent-data/logs`）：

```bash
docker exec nexent-runtime tail -20 /mnt/nexent-data/logs/model_call/nexent_model_call.log
```

应能看到 `event=chat_completion_create` 且没有异常堆栈。

> 补丁后如果出现**新的**报错（例如 401/429/5xx、JSON 解析失败），说明原先被 zstd 错误盖住的真实上游错误暴露出来了。这是预期行为：按真实 HTTP 错误继续排查模型鉴权、配额或网关，而不是回滚。

---

## 5. 回滚

```bash
HTTPX_DEC=$(docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import httpx._decoders as d; print(d.__file__)" 2>/dev/null | tr -d '\r')
docker exec nexent-runtime cp "$HTTPX_DEC.bak-$D" "$HTTPX_DEC"
docker restart nexent-runtime
```

如果容器已经改坏、Python 无法导入 httpx，用宿主机备份覆盖（路径按 0.4 的实际值替换 `python3.11`）：

```bash
docker cp ~/httpx_decoders.py.bak-$D nexent-runtime:/opt/backend/.venv/lib/python3.11/site-packages/httpx/_decoders.py
```

```bash
docker restart nexent-runtime
```

回滚后 `ACCEPT_ENCODING` 会重新包含 `zstd`（恢复原始行为）。本补丁只改代码文件，数据库零变更。

> 如果同时改过 `nexent-config`，把本节命令中的 `nexent-runtime` 替换为 `nexent-config` 再执行一遍。

---

## 6. 持久化与边界

### 6.1 热修复会丢

补丁只存在于容器可写层。以下操作会丢失：

- `docker compose up -d --force-recreate`（注意带 `-p nexent`）
- 镜像升级、重新拉取、删除容器
- 如果容器根文件系统是只读的（compose 里 `read_only: true`），容器内无法写文件，请直接采用 6.2 的派生镜像方案。

### 6.2 长期方案（按优先级）

1. **升级到 v2.8.0 及以上**：主链路使用 `openai 3.x + httpx2`，在 Python ≤3.13 下 httpx2 只认 `backports.zstd`，而镜像默认不装它，所以默认头是 `gzip, deflate`，不会再走 zstd 解压。验证命令：

   ```bash
   docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import openai, httpx2; from httpx2._client import ACCEPT_ENCODING; print(openai.__version__, httpx2.__version__, ACCEPT_ENCODING)"
   ```

   预期 `Accept-Encoding` 不含 `zstd`。

   > 注意：如果有人安装了 `httpx2[zstd]`（会带入 `backports.zstd`），或运行时使用 Python 3.14+ 且启用了标准库 `compression.zstd`，httpx2 会重新启用 zstd。此时同样可以对本热修复稍作扩展：找到 `httpx2/_decoders.py`，追加同样的 `SUPPORTED_DECODERS.pop("zstd", None)`。

2. **构建派生镜像**：以现场镜像为基础，在 Dockerfile 中固化补丁（避免每次重建后重新热修）：

   ```dockerfile
   FROM <现场镜像tag>
   RUN /opt/backend/.venv/bin/python -c "import httpx._decoders as d; p=d.__file__; s=open(p).read(); open(p,'a').write('\n# NEXENT HOTFIX: disable zstd content-encoding\nSUPPORTED_DECODERS.pop(\"zstd\", None)\n') if 'NEXENT HOTFIX: disable zstd' not in s else None"
   ```

3. **产品侧加固**：在模型 HTTP 客户端显式固定 `Accept-Encoding: gzip, deflate`（例如 `openai_llm.py` 构造 `DefaultHttpxClient` 时加 `headers=...`，或给 OpenAI client 传 `default_headers=...`），从源头避免未来 SDK 再次自动协商 zstd。

### 6.3 影响范围与风险

- 本补丁会关闭该容器内**所有 httpx 客户端**的 zstd 解压能力；其它出站 HTTP 请求会回落到 gzip/deflate/identity，功能不受影响。
- 不卸载 `zstandard` 包，因此 `langsmith`/`langchain` 的依赖不受影响。
- 不修改数据库，回滚零副作用。
- 如果上游服务在客户端**没有**声明 zstd 的情况下仍强行返回 `Content-Encoding: zstd`，httpx 会把它当作未知编码并返回原始字节（不会再抛 zstd 错误，但可能表现为 JSON 解析失败）。这种情况下需要修上游代理/网关，而不是继续在 Nexent 侧兜底。

---

## 附录 A：为什么改这一行就能生效

v2.4.0 的模型调用走 OpenAI SDK → `httpx 0.28.x`。httpx 在导入时根据 `SUPPORTED_DECODERS` 计算默认头：

```python
# httpx/_client.py
ACCEPT_ENCODING = ", ".join(
    [key for key in SUPPORTED_DECODERS.keys() if key != "identity"]
)
...
b"Accept-Encoding": ACCEPT_ENCODING.encode("ascii"),
```

```python
# httpx/_decoders.py
SUPPORTED_DECODERS = {
    "identity": IdentityDecoder,
    "gzip": GZipDecoder,
    "deflate": DeflateDecoder,
    "br": BrotliDecoder,
    "zstd": ZStandardDecoder,
}
if brotli is None:
    SUPPORTED_DECODERS.pop("br")
if zstandard is None:
    SUPPORTED_DECODERS.pop("zstd")
```

`zstandard` 是 `langchain → langchain-core → langsmith` 带进来的传递依赖，所以 `zstd` 被保留，默认头变成 `gzip, deflate, zstd`。我们在文件末尾追加 `SUPPORTED_DECODERS.pop("zstd", None)`，在 `_client.py` 计算 `ACCEPT_ENCODING` 之前把 zstd 移除，头就变成 `gzip, deflate`，zstd 解码器也不会再被选中。

v2.8.0 不再出这个问题的原因：OpenAI SDK 3.x 改用 `httpx2`，而 httpx2 在 Python ≤3.13 下只认 `backports.zstd`（镜像未安装），所以 zstd 被自动移除，默认头是 `gzip, deflate`。

---

## 附录 B：只想改模型调用（备选）

如果安全策略不允许改第三方库，可以改 SDK 的 `openai_llm.py`，只影响 Nexent 的模型客户端。先定位实际加载的文件：

```bash
docker exec nexent-runtime /opt/backend/.venv/bin/python -c "import nexent.core.models.openai_llm as m; print(m.__file__)"
```

在 `super().__init__(*args, **kwargs)` 之前插入：

```python
client_kwargs = kwargs.get("client_kwargs", {})
default_headers = dict(client_kwargs.get("default_headers") or {})
default_headers.setdefault("Accept-Encoding", "gzip, deflate")
client_kwargs["default_headers"] = default_headers
kwargs["client_kwargs"] = client_kwargs
```

然后 `py_compile`、清理 `__pycache__`、重启 `nexent-runtime`。该方式依赖 OpenAI SDK 对 `default_headers` 的支持；不同小版本行为可能不同，**热修复仍优先用正文的 httpx 补丁**。

---

## 变更记录

| 日期 | 内容 | 验证 |
|------|------|------|
| 2026-10-26 | 初版：v2.4.0 容器内 httpx `_decoders.py` 移除 zstd | 容器 `/tmp` 副本验证：`ACCEPT_ENCODING` 从 `gzip, deflate, zstd` 变为 `gzip, deflate`，`SUPPORTED_DECODERS` 不再含 zstd |
| 2026-10-26 | 现场验证（v2.4.1 镜像，VERSION 显示 v2.4.0，openai 3.x + httpx2）：先补 httpx 后 httpx AE 已为 `gzip, deflate`，但 OpenAI 客户端仍发 zstd；补 `httpx2/_decoders.py` 后 client AE 不再含 zstd | 现场复测通过，DeepSeek 对话恢复正常 |