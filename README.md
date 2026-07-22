# 个人作品集

本仓库是个人博客和作品导航入口。完整展示项目各自保留独立仓库、依赖和部署栈，博客通过线上地址跳转进入项目。

## 目录职责

```text
frontend/                    个人博客、作品展示和 AI 介绍助手
nginx/                       主域名及展示项目子域名的公网入口
project/                     本地展示项目集合，不纳入本仓库版本控制
  【项目】AI角色扮演/          Aura 独立 Git 仓库和完整部署栈
```

线上入口：

- `https://beta-demo.top`：个人博客
- `https://www.beta-demo.top`：Aura AI 角色扮演

## 本地开发

```bash
cd frontend
npm ci
npm run dev
```

未通过 `GEMINI_API_KEY_FILE` 提供密钥时，博客仍可运行，但 AI 助手只返回内置介绍。

## 博客内容后台

后台入口：`https://beta-demo.top/admin`

后台可管理以下内容：

- 个人资料可视化表单
- 技术栈分类与标签
- 作品项目新增、编辑与删除
- 博客文章新增、编辑与删除
- Markdown 编辑与实时预览
- JPG、PNG、WebP、GIF 图片上传和文章插入
- 文章封面图
- 草稿与发布状态

首次启用前，在仓库外建立部署 secret 目录。五个文件必须预先存在，目录权限设为 `0700`，文件权限设为 `0600`；`postgres_password` 只属于数据库维护 owner，`postgres_app_password` 只属于长期运行的后端角色；未启用 AI 时 `gemini_api_key` 保持空文件。以下命令不会把随机值写入命令参数或终端输出：

```bash
SECRET_DIR=/absolute/path/outside-the-repository/portfolio-secrets
install -d -m 0700 "$SECRET_DIR"
umask 077
openssl rand -hex 32 > "$SECRET_DIR/postgres_password"
openssl rand -hex 32 > "$SECRET_DIR/postgres_app_password"
openssl rand -hex 32 > "$SECRET_DIR/app_secret_key"
: > "$SECRET_DIR/gemini_api_key"
```

使用已安装后端依赖的本地虚拟环境生成管理员哈希。密码由 `getpass` 交互读取，不会进入 Shell 历史；编码哈希直接写入 secret 文件，不会显示在终端：

```bash
SECRET_DIR=/absolute/path/outside-the-repository/portfolio-secrets
backend/.venv/bin/python <<'PY' > "$SECRET_DIR/blog_admin_password_hash"
from getpass import getpass
from argon2 import PasswordHasher
from argon2.low_level import Type

password = getpass("新管理员密码: ")
confirmation = getpass("再次输入: ")
if password != confirmation or len(password) < 16:
    raise SystemExit("两次输入必须一致，且密码至少 16 个字符")
print(PasswordHasher(type=Type.ID).hash(password))
PY
chmod 0600 "$SECRET_DIR"/*
```

根目录 `.env` 只保存这五个文件的绝对宿主路径和非敏感配置，不再保存 secret 值：

```dotenv
PORTFOLIO_POSTGRES_PASSWORD_SECRET_FILE=/absolute/path/outside-the-repository/portfolio-secrets/postgres_password
PORTFOLIO_POSTGRES_APP_PASSWORD_SECRET_FILE=/absolute/path/outside-the-repository/portfolio-secrets/postgres_app_password
PORTFOLIO_ADMIN_PASSWORD_HASH_SECRET_FILE=/absolute/path/outside-the-repository/portfolio-secrets/blog_admin_password_hash
PORTFOLIO_APP_SECRET_KEY_SECRET_FILE=/absolute/path/outside-the-repository/portfolio-secrets/app_secret_key
PORTFOLIO_GEMINI_API_KEY_SECRET_FILE=/absolute/path/outside-the-repository/portfolio-secrets/gemini_api_key
AUTH_COOKIE_SECURE=true
POSTGRES_USER=portfolio
POSTGRES_APP_USER=portfolio_app
POSTGRES_DB=portfolio_cms
```

`.env` 权限应设为 `0600`，不得提交 Git。Compose 使用 file-backed secret，只把源文件挂载给一次性 `secret-init`；该容器保持只读根文件系统、无网络和无 Linux capabilities，并把内容复制到按服务隔离的命名卷。PostgreSQL 只挂载 owner 密码；一次性 `database-init` 挂载 owner 与 app 密码；长期运行的后端只挂载 app 密码、管理员哈希和会话密钥。各服务只接收对应的容器内 `*_FILE` 路径，原始 secret 值不会进入环境。管理员原始密码不得写入任何文件；后端只接受 `BLOG_ADMIN_PASSWORD_HASH_FILE` 提供的 Argon2id 哈希，不提供明文密码兼容模式。

两个 PostgreSQL 密码、管理员 Argon2id 哈希和 `APP_SECRET_KEY` 文件必须非空；Gemini 文件可以为空，但必须存在。初始化器会在替换任何当前运行时文件前完成全部输入预检和暂存，并清理上次中断留下的 `.tmp`、旧版明文管理员密码文件以及后端卷中遗留的 owner 密码。相同输入可安全重复执行。

不要把秘密写入 `.env`、命令参数、Shell 历史、Compose 展开输出、日志或 Git。不要把 secret 文件放进仓库，即使文件名已被忽略；生产平台具备原生秘密管理时，应使用 Compose override 将这些 secret 替换为 external secret provider。

从旧版环境变量部署升级或后续轮换时，使用以下可重复流程：

先校验最近一次异地备份，然后用部署账号启动受项目级维护锁保护的专用 Shell。锁是非阻塞的；同一 Compose project 正在备份、恢复或轮换时，第二项维护操作会在任何 Docker 或数据操作前退出。自定义 project 必须通过 `PORTFOLIO_COMPOSE_PROJECT_NAME` 传入，Shell 退出时自动释放锁。

```bash
scripts/maintenance-lock.sh --operation secret-rotation -- bash
```

以下步骤必须全部在该受锁 Shell 内完成；不要在其中再次启动 `backup.sh` 或 `restore.sh`：

1. 开启维护窗口并运行 `docker compose stop backend`，防止数据库密码切换期间继续写入。
2. 在 secret 目录所在文件系统中创建五个权限为 `0600` 的 `.next` 文件。owner、app、管理员、会话和 Gemini 凭据必须分别生成；管理员原始密码只用于交互生成 Argon2id 哈希。
3. 在当前 PostgreSQL 容器内通过交互式 `psql` 的 `\password` 将 `POSTGRES_USER` 维护 owner 改为 owner `.next` 文件中的同一个新密码，不要把新密码写进命令行。app 密码由第 7 步安全同步。
4. 预检五个 `.next` 文件后，使用同文件系统内的 `mv` 逐个原子替换 `.env` 所指向的稳定文件；所有替换完成前不要运行 Compose。删除旧 `.env` 中的 `POSTGRES_PASSWORD`、`POSTGRES_APP_PASSWORD`、`BLOG_ADMIN_PASSWORD`、`BLOG_ADMIN_PASSWORD_HASH`、`APP_SECRET_KEY` 和 `GEMINI_API_KEY` 值。
5. 确认 `.env` 和五个 secret 文件权限均为 `0600`、路径位于仓库外且未被 Git 跟踪，然后运行 `docker compose config --quiet`。不要在共享终端或任务日志中输出完整的 `docker compose config`。
6. 运行 `docker compose run --rm --no-deps -T secret-init`。只有该命令成功后，才重建应用服务；失败时保持 backend 停止，修正输入后安全重试。
7. 运行 `docker compose run --rm --no-deps -T database-init`。该容器以 owner 执行 Alembic，并从 app secret 文件创建或更新 `POSTGRES_APP_USER`；密码通过文件读取和数据库连接传递，不进入命令参数、环境或日志。失败时不得启动 backend。
8. 运行 `docker compose up --detach --wait --wait-timeout 60 --force-recreate --no-deps backend frontend nginx`，再校验 readiness、新管理员密码和 AI 调用，并确认旧 owner/app 数据库凭据、旧管理员密码、旧会话及旧 AI Key 已失效。验证完成后退出专用 Shell 以释放维护锁。

使用默认数据库名称时，第 3 步可运行 `docker compose exec postgres psql --username portfolio --dbname portfolio_cms`，再在 `psql` 内执行 `\password portfolio`。自定义了 `POSTGRES_USER` 或 `POSTGRES_DB` 时必须使用实际名称。

已有 PostgreSQL 数据卷不会因为 Compose secret 变化而自动修改 owner 密码；必须先完成交互式 `\password`。`database-init` 会幂等同步 app 密码和权限。任一数据库角色与新 secret 尚未同步时应保持 backend 停止；可修正输入后重复运行 `secret-init` 和 `database-init`，不要跳过失败步骤。轮换 `APP_SECRET_KEY` 后所有旧管理员会话失效，这是预期行为。

默认安全策略会对管理员登录失败进行双层限制：Nginx 负责入口速率限制，后端在同一客户端 15 分钟内连续失败 5 次后锁定 15 分钟。`ADMIN_LOGIN_*` 变量可调整该策略；`AUTH_TRUSTED_PROXY_CIDRS` 只能包含会覆盖 `X-Real-IP` 的可信反向代理。

后台的所有写操作还会校验 `Origin`/`Referer`/`Sec-Fetch-Site`，`PUBLIC_ORIGIN` 应显式设为后台所在的完整源（默认 `https://beta-demo.top`）。内容保存使用强制 `If-Match` 版本条件，避免多会话编辑时静默覆盖。上传图片会按真实格式及尺寸、像素、动画帧数和累计解码像素验证，不信任客户端声明的文件名或 MIME 类型；`MAX_MEDIA_FILES` 是媒体库存硬上限，默认 `1000`，达到上限后新上传会被拒绝。

AI 接口默认限制请求体、对话条数、字符数、输出 token、上游超时、并发数与每 IP/全局日配额。请求体固定为入口实际支持的 `64 KiB`；对话条数、单条用户消息和历史字符上限不得低于浏览器编译时合同，避免合法 UI 请求被运行时配置拒绝。服务端把上游回复限制为最多 `10500` 字符，使一条完整回复和下一条最多 `1500` 字符的用户消息始终能同时进入浏览器的 `12000` 字符历史预算。单进程内存配额会在容器重启后重置，Nginx 入口限流作为独立外层防线；多副本部署前应将日配额与登录失败计数迁移到 Redis 等共享原子存储。

数据库请求默认使用 3 秒连接超时、3 秒连接池等待超时和 4 秒语句超时；三项运行时预算合计不得超过 25 秒，且单项不得超过 20 秒，为入口的 30 秒响应超时保留确定余量，避免客户端超时后写事务仍继续提交。迁移语句不经过请求入口，单独使用最长 120 秒的默认预算。可通过 `.env` 中的 `DB_CONNECT_TIMEOUT_SECONDS`、`DB_POOL_TIMEOUT_SECONDS`、`DB_STATEMENT_TIMEOUT_MS` 和 `DB_MIGRATION_STATEMENT_TIMEOUT_MS` 在上述边界内调整。

仅修改应用代码且未变更任何 secret 时，统一使用部署脚本：

```bash
scripts/deploy.sh
```

脚本先获取与备份、恢复相同的项目级维护锁，在旧服务仍在线时构建镜像；构建成功后才停止 backend，刷新隔离的运行时 secret，单独启动并等待 PostgreSQL 健康，再运行一次性 `database-init`。只有迁移和权限对账成功，才会使用 `--no-deps` 启动并等待 backend、frontend 和 nginx；任一步失败都会返回非零，迁移失败时 backend 保持停止。自定义 Compose project 使用 `PORTFOLIO_COMPOSE_PROJECT_NAME=名称 scripts/deploy.sh`，不要直接使用一组无锁的 `docker compose up` 命令替代它。

`database-init` 是唯一会自动执行 `alembic upgrade head` 的应用容器；API backend 不持有 owner 凭据，也不能创建表、数据库、角色或临时表。它是 `NOSUPERUSER`、`NOCREATEDB`、`NOCREATEROLE`、`NOINHERIT`、`NOREPLICATION`、`NOBYPASSRLS` 角色，只拥有业务表 `SELECT/INSERT/UPDATE/DELETE`、迁移版本只读及业务 sequence 的 `USAGE/SELECT`。从早期 root 容器升级且已有上传文件时，先启动受锁专用 Shell，再一次性修正旧数据卷权限：

```bash
scripts/maintenance-lock.sh --operation uploads-permission-migration -- bash
set -Eeuo pipefail
docker compose build backend database-init
docker compose stop backend
docker compose run --rm --no-deps -T secret-init
docker compose up --detach --wait --wait-timeout 60 --no-deps postgres
docker compose run --rm --no-deps --user 0:0 --cap-add CHOWN --entrypoint chown backend -R 10001:10001 /app/uploads
docker compose run --rm --no-deps -T database-init
docker compose up --detach --wait --wait-timeout 60 --no-deps backend frontend nginx
exit
```

该专用流程的任一步失败都必须保持 backend 停止；修正问题后从受锁 Shell 内的 `secret-init` 开始重试，不能跳过数据库迁移或 readiness。

初始迁移可能接管 Alembic 引入前已经存在的内容表，因此禁止自动降级删除这些表；需要回退数据库时使用已校验的备份恢复。

后台保存的内容写入独立 PostgreSQL 数据卷，上传图片写入 `portfolio_portfolio_uploads` 数据卷。单个内容文档最多 `2 MiB`，最多保留 `100` 个历史修订；两项均只允许向下调整。公开博客只返回状态为 `published` 且已到定时发布时间的文章，草稿和尚未到期的文章仅在后台可见。公开博客会优先读取数据库内容；CMS 拉取最多等待 20 秒，给入口的 30 秒响应预算保留渲染和降级余量。短时故障使用有时限的 stale 快照，完全没有可信快照时仍渲染编译默认内容，但返回 `503`、`noindex` 和 `Cache-Control: no-store`，sitemap/RSS 同样返回 `503`，避免搜索引擎把故障内容当作当前版本。Nginx 的存活检查只依赖前端，冷启动时不会因 backend 未 ready 阻断该降级页面；`/backend/health/ready` 仍须由独立探测监控。

## 生产部署

### 0. 发布来源与迁移门禁

生产交付必须来自一个已经完成验证的确定 Git commit。发布前将运行所需的源码、迁移、锁文件、部署脚本和文档纳入同一提交，并确认工作树干净；服务器应检出该 commit 的 clean clone，或只接收由 `git archive <commit>` 生成的源码归档。禁止使用 `scp -r .` 上传整个工作目录：该方式会混入 `.git`、未跟踪文件、本地数据库、日志、缓存、旧 `.env` 或其他不属于发布物的状态。TLS 文件、生产 `.env`、file-backed secret 和数据备份必须通过独立的受控渠道配置，不能打进源码归档。

迁移已有文章、媒体或数据库前，必须先在源环境生成 signed format v3 备份，将其同步到异地存储，再使用独立保存的公钥运行 `scripts/verify-backup.sh` 验证异地副本。只有验证成功的 v3 备份才能作为默认迁移和生产恢复源；unsigned format v1/v2 只保留为来源已由独立渠道确认后的隔离取证兼容路径，不能代替上线前备份。

生产 Secret 必须按“博客内容后台”章节在服务器仓库外重新生成，并为新环境轮换全部旧值。只从当前 `.env.example` 新建生产 `.env`，不要复制开发机、旧服务器或历史版本的 `.env`，也不要复用其中曾以明文环境变量保存的值。

### 1. DNS

将以下记录解析到同一台部署服务器：

- `beta-demo.top`
- `www.beta-demo.top`

`beta-demo.top` 由本仓库提供；`www.beta-demo.top` 依赖独立 Aura 仓库中的 `aura-app` 服务。只部署本仓库时，博客主域名可以正常运行，但 `www` 会按入口配置返回 `502`；需要启用 `www` 时必须另行交付并启动 Aura，Aura 不包含在本仓库的 clean clone 或 `git archive` 中。

### 2. TLS 证书

在 `nginx/certs/` 中放置：

```text
beta-demo.top.pem
beta-demo.top.key
```

私钥权限必须精确设为 `0600`，由当前部署账号拥有且不能存在额外硬链接；证书和私钥均不能是符号链接。证书目录已被 Git 忽略。`beta-demo.top.pem` 必须包含服务证书及所需的中间证书链；Nginx 容器健康检查默认使用镜像系统 CA，并校验证书链、`beta-demo.top` 主机名和有效期。`NGINX_HEALTH_CA_FILE` 只用于 CI 或内部私有 CA 场景，值必须是容器内可读的 CA 文件路径；生产公网证书不要把当前 leaf 证书设为该变量，否则会掩盖缺失的中间证书链。

在宿主机或证书提供商配置 ACME 自动续期，续期产物应以普通文件安全更新为完整证书链和匹配私钥。每次更新后先检查文件权限、SAN、有效期和密钥匹配，再执行 Nginx 配置检查与平滑重载，最后从生产服务器之外验证公网证书。到期告警是续期失败的兜底，不能替代自动续期；具体探测与告警合同见 `docs/runbooks/production-monitoring.md`。

### 3. 启动博客和公网入口

本项目要求 Docker Compose `2.30.0` 或更高版本，以支持 `up --wait` 和当前 Compose 规范。file-backed secret 是保持 `secret-init` 根文件系统只读的运行时要求，不要改回 environment-backed secret。首次部署和升级前先确认：

```bash
docker compose version --short
```

版本低于 `2.30.0` 时先升级 Compose 插件，不要尝试用旧版解析生产配置。

单独运行博客栈时，低流量生产主机最低建议从 `2 vCPU`、`4 GiB` 内存和 `40 GiB` SSD 可用空间起步，并为 Docker 镜像构建、PostgreSQL WAL、上传媒体和回滚版本保留余量；备份的唯一副本不计入这 `40 GiB`，必须另存异地。Aura 与博客同机时应在此基础上单独增加 Aura 的资源预算。上线后根据容器峰值、磁盘增长和构建期间的实际占用扩容，不应因为资源不足而删除 Compose 的现有限制。

```bash
cp .env.example .env
chmod 600 .env
docker compose config --quiet
scripts/deploy.sh
```

首次启动与后续普通升级使用同一个失败关闭流程。`deploy.sh` 会先运行部署 preflight 和 `docker compose config --quiet`，且不会输出 `.env` 或 secret 文件内容；Compose 仍按配置解析非敏感设置和 file-backed secret 路径。部署前应先人工确认这些路径、文件权限和最近一次 signed v3 异地备份有效。

全新的空 CMS 没有可公开发布的内容时，backend、frontend 和 Nginx 可能已经全部 ready，但首页会按内容降级合同返回 `503`。此时 `deploy.sh` 会在最终公网首页验收处返回非零，并明确保留这些已 ready 服务供初始化；这不是部署完成，也不要为了消除退出码停止或重建数据卷。访问 `https://beta-demo.top/admin` 登录并保存有效的初始内容，然后重新运行 `scripts/deploy.sh`，并从外部确认首页精确返回 HTTP `200`、`/backend/health/ready` 返回 ready，才可将首次部署标记为成功。

根 Compose 会创建 `portfolio-showcase` Docker 网络，供独立展示项目接入。

运行时网络按职责隔离：Nginx 与前端位于 `edge`，Nginx 与后端位于内部 `app` 网络，只有后端和 PostgreSQL 位于内部 `db` 网络。前端无法直接连接数据库；Nginx 会通过 Docker DNS 动态跟踪前后端容器地址，单独重建应用容器后无需同步重建入口。所有服务根文件系统均为只读，只通过显式命名卷和有容量上限的 `tmpfs` 保留必要写入面。

Compose 为每个服务设置了 CPU、内存和 PID 上限。这些默认值面向小型单机作品集，调整前应先观察峰值内存、图片处理和数据库负载，不要直接取消限制。

主域名的普通请求体最多 `64 KiB`，登录最多 `16 KiB`；在全局 128 个并发请求的最坏情况下，请求体缓冲预算不超过约 `8 MiB`，低于 Nginx `/var/cache/nginx` 的 `16 MiB` tmpfs。内容保存和图片上传使用精确路由、无请求缓冲的流式代理，并共享全局 4 个、单 IP 2 个大请求并发上限，因此合法并发上传不会把完整文件写入 Nginx tmpfs。上传和内容入口分别允许 `9 MiB` 与 `3 MiB` 请求体，为后端固定的 `8 MiB` 文件和 `2 MiB` 内容业务上限保留 multipart/JSON framing 余量；`MAX_UPLOAD_MB` 与 `MAX_CONTENT_BYTES` 只允许向下调整，超过业务上限会在后端启动配置校验时失败。

前端收到 `SIGTERM` 后最多用 `SHUTDOWN_TIMEOUT_MS` 排空在途请求，默认且最大为 `18000` 毫秒，只允许向下调整；Compose 的 `20s` `stop_grace_period` 始终为进程退出保留至少 2 秒余量。

### 4. 启动 Aura

```bash
cd project/【项目】AI角色扮演
cp .env.example .env
docker compose up --build -d
```

Aura 的内部 Nginx 会以 `aura-app` 别名加入共享网络。公网入口将 `www.beta-demo.top` 转发到该服务；Aura 停止时，博客仍可独立运行，`www` 入口会返回 `502`。

## 备份与恢复

备份包含 PostgreSQL custom-format dump、上传媒体归档、manifest、规范化 SHA-256 清单和独立 RSA-PSS 签名。备份期间会暂停 backend 写入，并在完成或失败后恢复原先运行状态。建议将输出目录同步到另一台机器或对象存储，不要只留在部署主机。

首次备份前，在仓库和所有备份根目录之外生成至少 3072 bit 的 RSA 密钥对。私钥只保留在备份生产主机，不能复制进备份目录、异地副本或监控主机；监控和恢复主机只部署公钥。密钥文件必须由执行脚本的账号拥有，链接数为 1，不能是符号链接；私钥权限必须为 `0600`，公钥权限为 `0600` 或 `0644`。

```bash
BACKUP_KEY_DIR=/absolute/path/outside-repository-and-backups/portfolio-backup-keys
install -d -m 0700 "$BACKUP_KEY_DIR"
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out "$BACKUP_KEY_DIR/private.pem"
chmod 0600 "$BACKUP_KEY_DIR/private.pem"
openssl pkey -in "$BACKUP_KEY_DIR/private.pem" -pubout \
  -out "$BACKUP_KEY_DIR/public.pem"
chmod 0644 "$BACKUP_KEY_DIR/public.pem"
```

根 `.env` 只记录外部路径，不保存 PEM 内容。`backup.sh` 使用当前私钥和配对公钥；验证、恢复与外部探针使用冒号分隔的公钥 keyring。轮换时先把新旧公钥同时放入 `PORTFOLIO_BACKUP_PUBLIC_KEY_FILES`，再把两个单数变量切换到新配对密钥；旧公钥必须保留到使用它签名的最后一份备份超过保留期。

```dotenv
PORTFOLIO_BACKUP_PRIVATE_KEY_FILE=/absolute/path/to/portfolio-backup-keys/private.pem
PORTFOLIO_BACKUP_PUBLIC_KEY_FILE=/absolute/path/to/portfolio-backup-keys/public.pem
PORTFOLIO_BACKUP_PUBLIC_KEY_FILES=/absolute/path/to/portfolio-backup-keys/old-public.pem:/absolute/path/to/portfolio-backup-keys/public.pem
```

```bash
scripts/backup.sh --output /path/to/off-host-backups
scripts/verify-backup.sh \
  --backup /path/to/off-host-backups/portfolio-backup-YYYYMMDDTHHMMSSZ \
  --public-key /absolute/path/to/portfolio-backup-keys/public.pem
scripts/restore.sh \
  --backup /path/to/off-host-backups/portfolio-backup-YYYYMMDDTHHMMSSZ \
  --public-key /absolute/path/to/portfolio-backup-keys/public.pem
```

`backup.sh` 与 `restore.sh` 自动持有和上述轮换入口相同的宿主机项目级锁。新备份开始前会记录原 active backend 的完整容器 ID，并在维护锁目录内原子维护权限为 `0600` 的持久 journal；备份完成后只对该原容器执行 `docker start`，再独立轮询容器 health，不会通过 Compose 创建或替换 backend。只有数据校验和服务恢复都成功才生成正常备份目录。如果备份数据已经完整且通过校验、但 backend 未能恢复 ready，命令会返回非零、保留 journal，并把产物保留为 `portfolio-backup-*.quarantine`。该目录仍可用 `verify-backup.sh` 复核，但在服务故障处理完成并人工确认前不得视为一次成功备份，也不应被自动恢复任务选中。

如果备份在停止 backend 后被 `SIGKILL` 或主机重启，下一次普通备份会先根据 journal 恢复并验证原容器，再开始新的备份；也可在保持同一 Compose project 配置时显式执行 `scripts/backup.sh --recover`，该命令可重复运行且不依赖 Compose 插件。journal 损坏、权限或 owner 不正确、存在符号链接或额外硬链接、项目身份不匹配，或记录的容器不属于当前 Compose project 的 backend 服务时，恢复会失败关闭并保留现场。新备份、正常恢复和 `restore.sh --recover` 强制要求 Docker Compose `2.30.0` 或更高版本；发现 stale backup journal 时，backend 恢复会先于新备份的版本门禁执行。

新备份强制使用 manifest v3，不存在可选的 v2 签名 sidecar 或无签名降级。manifest 除 `personal-portfolio` 应用身份、兼容版本和 Alembic head 外，还固定记录 `signature_format_version=1`、`signature_algorithm=rsa-pss-sha256-mgf1-sha256-saltlen32`，以及规范 SPKI DER 的 SHA-256 key id（`spki-sha256:<64 位小写十六进制>`）。`SHA256SUMS` 必须按 `database.dump`、`uploads.tar`、`manifest.txt` 顺序，以小写 SHA-256、两个空格和 LF 精确编码。

签名消息不是单纯的文件摘要，而是以下精确字节串：

```text
b"personal-portfolio-backup-signature-v1\0" + SHA256SUMS 的原始字节
```

`SHA256SUMS.sig` 是二进制 RSA-PSS 签名，参数固定为 SHA-256、MGF1-SHA-256 和 32-byte salt。不要用普通 `openssl dgst SHA256SUMS` 代替项目验证器；它没有加入 domain separation，也不会执行 manifest、key id、密钥路径和恢复对象策略。`backup.sh` 在停止 backend 前验证 OpenSSL、密钥安全属性、配对关系和 PSS 签验能力，签名后再用独立公钥完整自验。`verify-backup.sh` 只按 manifest key id 从全部配置公钥中精确选钥，并严格校验字段、文件大小、归档成员和校验和；任何 v3 字段、key id、签名或密钥配置异常都会失败关闭，不能转入 legacy。

验证器还会结构化解析 `pg_restore --list` 的实际可恢复对象。dump 必须恰好只包含 `public` 下的 `alembic_version`、`site_content`、`content_revisions` 以及固定的 sequence、default、主键和 data 条目；额外 schema、table、extension、function、trigger、comment、重复对象或异常 OID 关系都会使验证失败。备份生成时也会主动排除 comments。

`restore.sh` 会先在私有输入快照上完成校验和、TOC 结构与 manifest 迁移链校验；任一门禁失败都发生在交互确认、容量 staging、隔离数据库创建和 backend 停止之前。通过后才由维护 owner 将 dump 恢复到随机命名的隔离数据库。首次数据 staging 写入前，脚本会流式展开 dump 估算隔离库、索引和 WAL 预算，并检查 PostgreSQL 与 uploads 卷的可用空间和 inode；预算会保留旧数据库和旧媒体与新 staging 同时存在的余量，不足时不会创建隔离库或媒体 staging 目录。dump 内实际 head 必须与 manifest 一致；旧 head 只有在它是当前 head 的已知祖先时，才会在隔离库中执行 `alembic upgrade head`。随后 `database-init` 在隔离库中重新对账 app 角色和最小权限，并由 app 身份完成 readiness 与内容预检。迁移和数据库 readiness 通过后，脚本还会验证 `site_content` 只有 `id=1` 的单例行、内容可按当前 `ContentPayload` 解析，并实际执行公开内容过滤。staged 媒体会复用正常上传的单文件大小、真实格式、完整解码、尺寸、帧数和累计像素校验；所有预检通过后才会停止 backend、激活媒体并交换数据库。未知版本、未来版本、多 head、容量不足、迁移失败、权限对账失败、readiness 失败、畸形内容或无效媒体均不会交换当前数据库，也不会激活新媒体，错误日志不会输出内容值。

恢复从首次创建隔离数据库开始，会在维护锁目录内维护权限为 `0600` 的原子 journal；默认目录是可跨普通主机重启保留的 `/var/tmp/portfolio-maintenance-<uid>`，目录权限为 `0700`。journal 只记录随机事务 token、由该 token 派生的临时数据库名、枚举阶段和 backend 原运行状态，不记录备份路径、secret 或业务内容。生产部署可通过绝对路径 `PORTFOLIO_RESTORE_STATE_DIR` 指定另一个持久宿主机目录；该目录不能放在临时容器文件系统中。

如果进程被 `SIGKILL`、宿主机重启或清理阶段中断，普通恢复会拒绝覆盖现有 journal。先保持同一 Compose project 和数据卷配置，再显式执行：

```bash
scripts/restore.sh --recover
```

`--recover` 使用同一个项目级维护锁，并按数据库名称和媒体事务目录的实际状态幂等恢复：提交前中断会恢复旧数据库与旧媒体；readiness 已通过且提交状态已经持久化后中断，则完成新数据的清理提交。成功后会按中断前状态恢复 backend 并删除 journal；重复执行会安全报告没有待恢复事务。journal 损坏、权限不正确、数据库名组合有歧义或媒体事务状态不完整时会失败关闭并保留现场；若 backend 已停止则不要手工启动，也不得删除 journal 或手工重命名数据库后继续尝试。

旧 format v1/v2 都没有协议级独立签名，默认连校验和恢复都会拒绝。仅在已通过独立渠道确认来源可信、没有 v3 副本且只在隔离环境检查时，才显式允许 unsigned legacy；format v1 因为还缺少应用身份和 Alembic 元数据，必须再加第二个门禁：

```bash
scripts/restore.sh \
  --backup /path/to/legacy-format-v1-backup \
  --allow-unsigned-legacy \
  --allow-legacy-v1
```

旧 format v2 只需 `--allow-unsigned-legacy`；format v1 必须同时提供两个选项。坏掉或缺失签名的 v3 绝不接受这些 legacy 参数。该兼容路径仍执行同一 TOC、容量、媒体和隔离恢复门禁；v1 以隔离库中实际的单一 Alembic head 为准，同样只接受当前迁移链的已知祖先并在 readiness 通过后激活。交互恢复要求输入 `RESTORE`；自动化恢复时才使用 `--yes`。

CI 会在隔离 PostgreSQL 16 和临时 TLS 环境中执行在线迁移、owner/app 密码独立轮换、runtime 角色属性与 DDL 拒绝矩阵、业务 CRUD、完整 Compose 健康启动、Nginx 配置检查、Docker DNS 容器替换回归，以及 72 MiB 媒体集的真实备份恢复。恢复演练覆盖旧迁移升级、畸形内容预检、普通失败自动回滚，以及媒体激活、数据库换名和提交清理阶段的 `SIGKILL` 后显式恢复；每个提交前失败点都必须保留原数据库、站点内容和上传媒体，提交后中断则必须保留已经通过 readiness 的新数据。生产环境仍应定期在隔离主机执行真实异地恢复演练，并记录 RPO、RTO 和演练结果。

## 运行监控

Docker `healthcheck` 只会将容器标记为 `unhealthy`，`restart: unless-stopped` 不会因为健康检查失败自动重启服务。生产环境至少应配置以下外部探测和告警：

- `https://beta-demo.top/` 与 `/backend/health/ready` 的公网可用性和延迟
- TLS 证书 30、14、7 天到期提醒
- 容器 unhealthy、退出和重启次数
- 5xx、429、登录锁定和上游响应时间
- PostgreSQL、Docker 数据目录、上传卷和备份目录的磁盘空间
- 最近一次成功异地备份的时间与校验结果

自动重启应由宿主机 supervisor 或编排器负责，并保留告警和失败上下文；数据库不可用时盲目重启 backend 通常不能解决根因。

## 依赖与供应链

应用生产镜像使用精确补丁版本的可读标签，所有基础镜像和第三方服务镜像同时固定不可变 digest；GitHub Actions 使用完整 commit SHA。Node `22.23.1` 与 Python `3.12.13` 同时固定在本地工具链文件、CI 和应用镜像中；更新运行时时必须同步这三层。Dependabot 每周检查 npm、pip、Docker 和 Actions 更新；升级镜像或 Action 时，应同时核对上游发布说明并更新对应摘要，不要恢复为只有可移动标签的引用。

`backend/requirements.txt` 和 `backend/requirements-dev.txt` 是人工维护的版本输入；Docker 与 CI 分别使用带哈希的 `requirements.lock` 和 `requirements-dev.lock`。修改输入后，用 Python `3.12.13`、`pip==25.3` 和 `pip-tools==7.5.2` 重新生成。`CUSTOM_COMPILE_COMMAND` 固定锁文件头中的可复现命令；`--no-annotate` 避免 macOS 与 Linux 只因 `# via` 注释不同而产生无意义 diff。两者均不可省略，否则依赖内容未变也会导致 CI 的锁文件比较失败。这里显式固定 pip，是因为该 pip-tools 版本尚不兼容 pip 26 的内部 API：

```bash
CUSTOM_COMPILE_COMMAND='python -m piptools compile --generate-hashes --no-annotate --strip-extras --no-emit-index-url --no-emit-trusted-host --output-file=backend/requirements.lock backend/requirements.txt' \
  python -m piptools compile --generate-hashes --no-annotate \
  --strip-extras --no-emit-index-url --no-emit-trusted-host \
  --output-file=backend/requirements.lock backend/requirements.txt
CUSTOM_COMPILE_COMMAND='python -m piptools compile --allow-unsafe --generate-hashes --no-annotate --strip-extras --no-emit-index-url --no-emit-trusted-host --output-file=backend/requirements-dev.lock backend/requirements-dev.txt' \
  python -m piptools compile --allow-unsafe --generate-hashes --no-annotate \
  --strip-extras --no-emit-index-url --no-emit-trusted-host \
  --output-file=backend/requirements-dev.lock backend/requirements-dev.txt
```

CI 会重新生成并比较锁文件。不要直接编辑 `*.lock`，也不要绕过 `--require-hashes`。

## 验证

```bash
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run test:e2e
npm --prefix frontend run build

env PYTHONPATH=backend backend/.venv/bin/python -m compileall -q \
  backend/app backend/test_support.py backend/tests backend/integration_tests backend/alembic
env PYTHONDONTWRITEBYTECODE=1 scripts/tests/run.sh
env PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/tests -v
env PYTHONPATH=backend backend/.venv/bin/python -m unittest discover -s backend/alembic/tests -v
backend/.venv/bin/python -m alembic -c alembic.ini upgrade head --sql
python3 scripts/scan_secrets.py --history

shellcheck scripts/*.sh scripts/tests/*.sh backend/docker-entrypoint.sh
git diff --exit-code -- backend/requirements.lock backend/requirements-dev.lock

docker compose config --quiet
docker compose build backend database-init frontend
docker compose ps
curl -fsS https://beta-demo.top/backend/health/ready

# 在独立 portfolio-recovery-test-* 项目中验证首次 secret 初始化、二次轮换和完整灾备。
PORTFOLIO_RUN_RECOVERY_INTEGRATION=true scripts/tests/recovery-integration.sh
```

锁文件 diff 检查应在使用本节“依赖与供应链”中的固定 Python 3.12 与 pip-tools 命令重新生成两份锁文件后执行。Playwright 和 server/smoke 测试会监听本机临时端口；受限执行环境需要显式允许 loopback 监听。

Nginx、Node 和 FastAPI 请求日志使用 JSON 格式并共享 `request_id`，所有容器日志默认轮换为每个 3 个 10 MB 文件。对外响应会返回 `X-Request-ID`，可用于将浏览器报错、边缘日志和应用异常关联；日志不得记录 Cookie、请求正文或异常消息。

GitHub Actions 还会执行 ShellCheck、当前工作树扫描和完整 Git blob 历史扫描。扫描器覆盖常见供应商凭据、私钥、Argon2id 哈希和高熵 secret 赋值，只输出路径、规则与 blob ID，不输出命中值。仓库托管平台仍应启用 secret scanning 与 push protection；自持扫描器不检测所有编码或派生 secret。

## Git 边界

`project/` 已加入根仓库 `.gitignore`。Aura 应在自己的仓库中独立提交和推送，不要将其嵌套提交到博客仓库。两个仓库应使用不同的远端地址。
