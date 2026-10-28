# FAQ 速查（11 条，内网自查版）

按现象对号入座；详细原理与完整命令见 `D:\projects\feishu\Nexent平台部署FAQ-复刻.md` 对应章节。

| # | 现象 | 自查命令 | 一句话解法 |
|---|------|----------|-----------|
| 1 | 登录后缺功能（无租户列表）、刷新即掉线 | `date`（对比真实时间） | 校时（chrony 或 `date -s`）+ **必须** `hwclock --systohc` 写硬件时钟 |
| 2 | Supabase db init 失败 / 后端 `can't start new thread`（Docker≤23.0） | `docker version` | 所有服务加 `security_opt: [seccomp:unconfined]`；建议升级 Docker≥23.0.1 |
| 3 | 容器访问外网/模型地址超时 | `iptables -t nat -L POSTROUTING -n -v \| grep 172.18` | 补 MASQUERADE：`iptables -t nat -A POSTROUTING -s 172.18.0.0/16 ! -o docker0 -j MASQUERADE`（重启丢失，需持久化） |
| 4 | 容器间按名称互访失败（域名解析失败） | `firewall-cmd --zone=trusted --list-all` | `firewall-cmd --permanent --zone=trusted --add-interface=br-{NetworkID}`（加网桥接口，不是网络名） |
| 5 | Supabase 容器起不来，报 ulimits/线程数 | 容器日志关键词 nofile | kong 服务下加 `ulimits: {nofile: {soft: 65536, hard: 65536}}` |
| 6 | clickhouse 报 `cd: null directory`（langfuse 监控） | `uname -m`（aarch64/鲲鹏？） | 换鲲鹏版镜像（附件 token `Wksdb2sGOoUJkUxjhORcvJTenrh`，约410MB，从原文档下载）；仍失败叠加第 2 条 seccomp 配置 |
| 7 | 改 .env/API Key 后重新部署不生效 | `docker inspect <容器> \| grep -A2 Env` | `docker compose -p nexent up -d --force-recreate <服务名>`（必须带 `-p nexent`；镜像名变量先 export） |
| 8 | 容器无限重启、服务起不来 | `docker inspect` 看 OOMKilled 与退出码 | 资源不足：`docker stats`/`free` 查余量，清理或扩配额后重建；别反复 down/up |
| 9 | 知识库创建失败/存量库不显示 | `df -h`（部署盘 >95%？） | 清磁盘到 95% 以下，必要时解除 ES 只读块；**不要调高水位线绕过**；建议独立磁盘+90% 告警 |
| 10 | 对话首 token 慢（工具测试却正常） | 查召回 topK 配置 | 调低 topK、启用 rerank、控制引用长度；用「工具直测 vs 完整链路」对比定位 |
| 11 | 新建空白智能体带了别的智能体提示词 | 查租户库表 app_config 废弃记录 | 清空该字段应急；新版本代码已修复 |
