# 生产外部探测与告警

## 目标

`scripts/production_probe.py` 从 Docker Compose 之外同时校验：

- 公网首页返回未重定向的 `200 text/html`。
- `/backend/health/ready` 返回 `200 application/json` 且内容为 `{"status":"ready"}`。
- 公网 TLS 证书可验证，且距离过期时间大于告警阈值。
- 最新已发布备份属于 `personal-portfolio`、使用独立签名的 format v3、不是 quarantine、没有超过 RPO 窗口，且三个数据成员的 SHA-256 与严格格式的 `SHA256SUMS` 一致。

探测器不发送 Cookie，不读取 secret，也不输出响应正文或异常详情。它只读取首页的 1 个字节和最多 4 KiB 的 readiness JSON 以校验响应合约，失败时只输出稳定错误码。

## 部署边界

公网和 TLS 探测必须从与生产服务器不同的主机或外部监控平台执行。在同一 Compose 网络中执行只能证明内部服务可达，不能发现 DNS、公网防火墙、TLS 或边缘路由故障。

备份目录应是异地备份存储的只读挂载或同步副本，不应指向生产主机上的唯一备份。只有 `portfolio-backup-YYYYMMDDTHHMMSSZ` 目录被认为已发布备份；隐藏暂存目录和 `*.quarantine` 不会计入新鲜度。

TLS 证书必须由宿主机 ACME 客户端或证书提供商自动续期，监控探针不负责续期。续期任务应在证书写入后检查完整链、两个域名的 SAN、私钥匹配和权限，Nginx 配置检查成功后再平滑重载；随后由本手册的外部探针确认公网实际提供的是新证书。30、14、7 天告警必须发送到独立通知通道，即使自动续期任务报告成功也不能关闭。

备份检查不依赖 Docker。它先用监控主机独立配置的公钥验证 `SHA256SUMS.sig`，再完整读取并流式计算 `database.dump`、`uploads.tar` 和 `manifest.txt` 的 SHA-256。`SHA256SUMS` 必须以小写十六进制、两个空格和 LF 换行，按固定顺序精确列出这三项，不能缺失、重排、重复或增加成员。探针还会要求 manifest 恰好符合可恢复的 v3 字段集合，并核对两个 payload 的真实字节数。

签名格式固定为 `signature_format_version=1`：对 `b"personal-portfolio-backup-signature-v1\0"` 与 `SHA256SUMS` 原始字节的拼接进行 RSA-PSS 签名，参数是 SHA-256、MGF1-SHA-256、32-byte salt；key id 是规范 SPKI DER 的 SHA-256。`SHA256SUMS.sig` 是二进制文件。监控端不能使用普通 `openssl dgst` 代替项目探针，因为它不会加入 domain、按 key id 选钥或校验恢复合约。

公钥必须由探针参数或 `PORTFOLIO_BACKUP_PUBLIC_KEY_FILES` 独立提供，绝不能从备份中读取。每个公钥必须位于仓库和备份目录外，由探针账号拥有、链接数为 1、不是符号链接，权限为 `0600` 或 `0644`，且 RSA 至少 3072 bit。轮换期把新旧公钥用冒号连接；探针会解析全部 key、拒绝空项和重复 key id，并只使用 manifest 指定的 key。监控主机不得部署备份私钥。

## 运行

```bash
scripts/production_probe.py \
  --origin https://beta-demo.top \
  --backup-root /mnt/offsite/portfolio \
  --public-key /etc/portfolio-backup-keys/public.pem \
  --max-backup-age-hours 26 \
  --tls-warning-days 30 \
  --max-http-latency-ms 5000
```

健康时返回 `0`，任一检查失败时返回 `1`。标准输出是单行 JSON，以下是一个检查项节选：

```json
{"checked_at_utc":"2026-07-17T00:00:00Z","checks":[{"age_seconds":7200,"code":"OK","latency_ms":null,"name":"backup","ok":true,"remaining_seconds":null}],"status":"ok"}
```

不应依赖数组顺序解析检查结果；以 `name`、`ok` 和 `code` 字段为准。常见错误码包括：

- `HTTP_UNAVAILABLE`、`HTTP_STATUS`、`HTTP_CONTRACT`、`HTTP_LATENCY`
- `TLS_UNAVAILABLE`、`TLS_EXPIRED`、`TLS_EXPIRING`
- `BACKUP_MISSING`、`BACKUP_INVALID`、`BACKUP_FROM_FUTURE`、`BACKUP_STALE`
- `BACKUP_SIGNATURE_CONFIG`、`BACKUP_UNSIGNED`、`BACKUP_UNTRUSTED`、`BACKUP_SIGNATURE_INVALID`

`BACKUP_MISSING` 表示没有已发布备份目录。`BACKUP_SIGNATURE_CONFIG` 表示公钥缺失、列表错误或密钥文件不安全；`BACKUP_UNSIGNED` 表示最新发布目录是 v1/v2，探针不提供 legacy 绕过；`BACKUP_UNTRUSTED` 表示没有公钥匹配 manifest key id；`BACKUP_SIGNATURE_INVALID` 表示 v3 签名缺失、尺寸错误或验签失败。通过签名后发现 manifest、payload size、成员或摘要不符合恢复合约则返回 `BACKUP_INVALID`。

## 告警接入

使用外部平台的“命令检查”、cron 包装器或 systemd timer 每 5 分钟执行一次。平台必须在返回码非零时向独立通知通道告警，并在连续成功后发送恢复通知。告警 webhook 或 API token 必须保存在监控平台的 secret store 中，不得放入本仓库或命令参数。

最低告警路由：

- 首页或 readiness 失败、TLS 无法验证：立即告警。
- TLS 距离过期 30 天：告警；14 天和 7 天升级严重程度。
- 最新备份超过 26 小时：告警；超过 48 小时升级。
- 监控任务本身超过 10 分钟没有上报：使用独立 dead-man switch 告警。

## 验收演练

首次上线及每季至少执行一次故障注入：

1. 将监控专用的备份副本时间改为超过 RPO，确认触发 `BACKUP_STALE`。
2. 在监控专用副本中修改 `database.dump` 的一个字节，确认触发 `BACKUP_INVALID`；演练结束后重新同步副本。
3. 在监控专用副本中破坏 `SHA256SUMS.sig`，确认触发 `BACKUP_SIGNATURE_INVALID`；临时只配置不匹配的轮换公钥，确认触发 `BACKUP_UNTRUSTED`。
4. 暂时让 readiness 探测返回 `503`，确认告警携带 `HTTP_STATUS` 且恢复后有通知。
5. 在隔离测试域名使用 7 天内过期的证书，确认触发 `TLS_EXPIRING`。
6. 保存演练时间、告警到达时间、恢复时间和工单或日志证据。

不得在生产备份唯一副本上修改 manifest 或时间戳来演练。
