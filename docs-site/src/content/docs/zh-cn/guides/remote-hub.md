---
title: Remote Hub 部署
description: 使用仅回环管理入口、Tailscale Serve 和无头 OAuth 运行 opencodex hub。
---

Remote Hub 将提供商凭据、模型目录和使用记录保存在一台主机上，经过身份验证的客户端直接访问其数据平面。管理平面相互独立：可选管理监听器只绑定 `127.0.0.1`，仅提供控制台和 `/api/*`。它不提供 `/v1/*`、`/healthz`、`/readyz` 或 WebSocket。不要直接发布 `10101`，也不要使用 Tailscale Funnel。

## 角色与信任边界

`standalone` 在一台机器上运行全部功能；`hub` 保存提供商密钥和使用记录；`client` 只保存连接状态和专属数据密钥。

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

客户端密钥写入仅所有者可读的 `service-api-token`，绝不会写入 `config.json`。连接期间，使用记录来自 hub 并按稳定的 `apiKeyId` 过滤；断开后显示本地记录。两者不会镜像。

Admin token 只能执行普通管理，永远不能创建用户同意会话。用户同意操作必须使用服务器签发的 `gui-session`、匹配的 Origin 和 CSRF。`Tailscale-User-Login` 只在独立管理入口可信；请在 `remoteGui.allowedTailscaleUsers` 中填写准确登录名。

## systemd/launchd 与 Tailscale Serve

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set corsAllowOrigins '["http://localhost:10100"]'

# 全新的 standalone 配置没有 `hub` 或 `remoteGui` 对象，而 `ocx config set` 不会
# 自动创建缺失的父对象：直接写嵌套路径会以 `config parent path not found: hub` 失败。
# 设置 `runtimeRole` 同样不会创建它。请先建对象，再设置字段。
ocx config set hub '{}'
ocx config set remoteGui '{}'
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

如果配置确实还是空的，也可以一次性写入整个对象：

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","managementIngress":{"enabled":true,"port":10101}}'
ocx config set remoteGui '{"allowedTailscaleUsers":["operator@example.com"]}'
```

只有在对象尚不存在时才用这种写法。整对象赋值是**替换**而不是合并：对已经含有 `hub.managementIngress` 的配置执行上面这行，该入口会被悄悄丢掉。调整既有配置时父对象已经存在，用嵌套路径逐个字段设置即可，不会动到其他值。

有两点决定一行命令能否被接受。值先按 JSON 解析，失败才回退为原始字符串——这就是 URL 要写成 `'"https://…"'` 的原因，对象、数组、布尔值和数字都必须是合法 JSON。另外 `hub` 和 `remoteGui` 采用严格模式：键名写错或取值不合规，都会在写入时以 `schema_invalid` 错误被拒绝，而不会变成一个永远不生效的设置。`managementPublicOrigin` 必须是不带路径、查询和片段的纯 origin。

systemd/launchd 从受保护的 `service-api-token` 读取密钥，plist 和 unit 不包含明文密钥。

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` 只证明进程存活。还必须验证 `/readyz`、经过身份验证的 `GET /v1/catalog` 和一次真实模型响应。管理端口只能监听 `127.0.0.1`。自建 TLS 代理应使用 `tailscale cert hub-name.tailnet-name.ts.net`，并仅代理到 `127.0.0.1:10101`。不要伪造 `Tailscale-User-*`；没有可信身份时请使用一次性配对。

### 为数据监听器提供 TLS

上面的 Serve 映射只发布**管理**入口。该入口从不提供 `/v1/*`、`/healthz` 或 `/readyz`，因此仅凭它并不能让远程客户端获得可用的数据平面。opencodex 自身也不终结 TLS：监听器是明文 HTTP，HTTPS 始终由运维方自建的前端负责。

数据平面同样可以交给 Serve，只需再用一个 HTTPS 端口。在 macOS 上还要多一跳，因为 Tailscale Serve 只能代理到 `127.0.0.1`，无法指向你绑定在节点自身 tailnet 地址上的监听器，而 App Store 版 macOS 客户端会直接拒绝远程目标。请在 hub 上运行一个回环转发器，再让 Serve 指向它：

```bash
# 任何回环 TCP 转发器都可以，socat 只是其中之一。请选一个 hub 尚未占用的端口：
# 启用回环 companion 后，127.0.0.1:10100 属于 opencodex 自己。
socat TCP-LISTEN:10110,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10110
tailscale serve status   # 应同时出现 443 -> 10101 和 8443 -> 10110
```

Serve 只接受有限的几个 HTTPS 端口。请用 `tailscale serve status` 确认映射确实建立，而不要假定端口被允许。转发器应与 hub 拥有相同的生命周期：后台 shell 作业会在重启时消失而服务会自行恢复，于是 hub 在运行却无法经 TLS 访问。请随 `ocx service install` 一起，用 launchd 或 systemd 托管它。

连接时把两个 origin 分开写。位置参数 URL 是**数据** origin，`/readyz` 和 `/v1/catalog` 都从这里获取；`--management-url` 是用于配对和密钥签发的控制台 origin。两者不必共用端口：

```bash
ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --admin-token-stdin
```

省略 `--management-url` 时，它取自 `/readyz` 响应，而该响应报告的正是 `hub.managementPublicOrigin`。两个 origin 不同时，显式写出更清楚。

**不要为图省事把数据监听器绑到 `127.0.0.1`。** 回环绑定正是 opencodex 判定“纯本地部署”的依据：它会不再要求数据凭据，转而要求请求的 `Host` 头也是回环地址。TLS 前端会原样转发 `Host: hub-name.tailnet-name.ts.net`，于是 `/v1/catalog` 返回 `403 origin_rejected`，而不做这项检查的 `/readyz` 仍然返回 `200`。部署看起来健康，却无法提供模型。请求路径中没有任何代码读取 `X-Forwarded-Host`，所以前端也无法修正。请把监听器留在 tailnet 地址上：凭据准入保持开启，而 `Host` 检查不会生效。

绑定 `0.0.0.0` 同样可行，而且因为回环也能访问，就不再需要转发器。但它会把数据端口发布到所有接口，所以只在你不在意其他网络的主机上这么做。

Serve 就绪后，请针对 HTTPS 数据 origin 重新执行验收检查：`/readyz`、经过身份验证的 `GET /v1/catalog` 和一次真实模型响应。

## OAuth、密钥轮换与断开

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# 仅限 HTTPS：
ocx connect rotate --admin-token-stdin
```

通过 `POST /api/oauth/login` 启动 OAuth。如果回调无法到达 hub，将最终 URL 或授权码作为 `{provider,input}` 发送到 `POST /api/oauth/login/code`。不要把 OAuth 码放入 argv 或日志。

轮换期间，旧密钥和新密钥在同一个 `apiKeyId` 下最多同时有效十分钟。旧密钥备份到 `service-api-token.prev`，新密钥以原子方式安装，并通过 `/v1/catalog` 验证后提交。如果提交结果不确定，请使用临时权限重新运行命令；在验证两个候选密钥前不要删除任何文件。

`ocx disconnect` 即使 hub 离线也能恢复本地状态，但不会吊销 hub 密钥。断开后，唯一的吊销入口是 hub 的 **Integrations → API Keys**。`ocx connect revoke --admin-token-stdin` 只能在仍连接时使用。

## Docker、回滚与排障

回滚时也要保留两个卷及其挂载路径。已有卷的所有权和权限不会自动修复。有关不使用 Compose 时的命名卷挂载及单独的状态路径，请参阅[英文基准指南](/guides/remote-hub/#docker-compose)。

部署使用两个独立持久卷：`ocx-state` 对应
`OPENCODEX_HOME=/home/bun/.opencodex`，`codex-state` 对应
`CODEX_HOME=/home/bun/.codex`。两个产品的 `auth.json` 格式不同，不能合并到同一个
主目录。即使根文件系统只读，这两个目录也可通过各自的卷写入。

此设置不会自动生成模型目录。在检查认证后的 `/v1/catalog` 前，必须生成或导入有效的
`/home/bun/.codex/opencodex-catalog.json`；空目录返回 `catalog_not_found` 404 属于正常行为。
升级会保留现有 `ocx-state` 并新增 `codex-state`，但不会自动迁移文件。若之前的临时方案
将模型目录放在 `.opencodex` 下，请先备份，再仅迁移模型目录文件，并保留仅所有者可访问的权限。
不要用一个产品的 `auth.json` 覆盖另一个。自定义 `CODEX_HOME` 时，必须将该确切目录挂载为
可写持久卷，并在 `${CODEX_HOME}/opencodex-catalog.json` 准备默认目录文件。
若 `model_catalog_json` 指向其他文件，也必须持久保存其解析后的路径。
在明确完成迁移前，请保留已有的环境变量与卷路径映射。
`docker compose down` 保留两个卷；`docker compose down --volumes` 则会删除
`ocx-state` 和 `codex-state`，包括配置、凭据、用量记录、数据密钥及 Codex 状态和模型目录。
这是破坏性操作，不能当作升级或重启命令使用。

opencodex 不发布官方 Docker 镜像，但仓库提供维护的 `Dockerfile` 和 `compose.yaml`，用于在本地构建按 digest 固定的 Bun 镜像。首次正常启动会在 `ocx-state` 卷的 `/home/bun/.opencodex/container-tls/cert.pem` 和 `/home/bun/.opencodex/container-tls/key.pem` 生成并保存一套自签名 TLS 身份；私钥仅所有者可读。后续启动会验证并复用它，因此数据端点使用 HTTPS。首次正常启动前，通过 stdin 初始化一次数据密钥；引导程序最多接受一行 512 字节的内容，不会输出密钥，并以仅所有者可读的权限保存规范的 `service-api-token`。

宿主机需要安装 Git 和 Bun。每次构建镜像前，都应从 Git 跟踪的源码生成规范兼容性清单，生成后到构建完成前不要修改源码。生成的 JSON 不加入 Git；`.git` 不进入 Docker 构建上下文。宿主机端口默认绑定 `127.0.0.1`。远程访问须显式使用 `OPENCODEX_BIND_ADDRESS=<LAN或Tailscale-IP> docker compose up -d`；`0.0.0.0` 会公开所有接口。请使用防火墙和经过身份验证的 TLS/tailnet 前端保护访问。

构建会拒绝过期清单，并将每个 SHA-256 分别与构建上下文及复制后的文件进行核对。清单对 `Dockerfile`、`compose.yaml`、`.dockerignore`、所有 Git 跟踪的 Docker 权威文件（引导、配置和探针）、`src/`，以及必需的 `package.json`、`bun.lock` 和 `scripts/model-metadata.source.json` 进行完整性验证。缺失或不匹配的文件、清单之外的源码或 Docker 权威文件，以及符号链接都会导致失败；`scripts/` 中仅纳入上述模型元数据文件。

```bash
git clone https://github.com/yansigit/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

容器以非 root 的 `bun` 用户运行，根文件系统只读，并且只发布 `10100`。复制公有证书（绝不要复制私钥），将其用作本地 CA 来验证默认的回环发布：

```bash
mkdir -p .tmp
docker compose cp hub:/home/bun/.opencodex/container-tls/cert.pem .tmp/opencodex-container-ca.pem
curl --cacert .tmp/opencodex-container-ca.pem --fail --silent https://localhost:10100/healthz
```

`OPENCODEX_PORT` 会同时控制宿主机发布端口和自动管理的 `tls.publicOrigin`，而容器内监听端口始终是 `10100`：

```bash
OPENCODEX_PORT=10190 docker compose up -d
curl --cacert .tmp/opencodex-container-ca.pem --fail --silent https://localhost:10190/healthz
```

远程发布必须显式设置 `OPENCODEX_BIND_ADDRESS`。自动生成的证书只覆盖 `localhost` 和 `127.0.0.1`；直接远程发布前，请用与准确远程名称匹配的证书和私钥替换卷中的身份，并设置 `OPENCODEX_PUBLIC_ORIGIN=https://准确的主机名和端口`。该值必须是准确的 HTTPS origin，不能包含路径、查询参数或片段。无论哪种方式都应使用防火墙；更推荐保留默认回环发布，并由经过身份验证的 TLS/tailnet 前端代理。

升级时，保留的旧版无 TLS 卷会在启动时迁移为每卷 TLS 身份，并根据已发布的宿主机端口写入 HTTPS origin；自定义证书路径会保留。若要回滚到旧版仅 HTTP 镜像，必须在当前镜像仍可用时先停止 hub 并仅移除 TLS 设置，然后再启动旧镜像；身份文件可以留在卷中：

```bash
docker compose down
docker compose run --rm hub bun run src/cli/index.ts config unset tls
# 选择或构建旧镜像，然后重新创建 hub
docker compose up -d
```

不要发布 `10101`，也不要把密钥放入 `ARG`、`ENV`、`COPY`、Compose、镜像历史或 argv。仅限容器内固定的 `https://127.0.0.1:10100` 回环地址，内部 health/readiness 探针可以使用 `rejectUnauthorized:false` 跳过证书身份验证；这只证明本地监听器和路由正常，不能作为外部验收。外部验收必须使用复制出的公有证书或系统信任库，并通过证书对应的准确主机名验证 HTTPS。healthcheck 后仍需单独验证 readiness、已认证目录和真实请求。`docker compose down` 会保留卷；`docker compose down --volumes` 还会删除配置、凭据、TLS 身份和数据密钥。

- hub 宕机：可以离线断开，但远程密钥仍待吊销。
- 目录过期：仅在临时故障时保留已验证的 LKG；认证、架构、大小或协议错误不会回退到本地提供商。
- `.prev` 恢复：保留两个文件，使用临时权限重新运行轮换。
- `hub-too-new`/`hub-too-old` 会指出需要升级的一端，并在本地写入前失败。
- 配对码一次性使用，失败次数会触发 429；丢失后请重新创建。
- 非回环 HTTP 配对会被直接拒绝，且没有任何开关可以豁免。请把管理 origin 放到 HTTPS 之后，或改在回环上配对；Admin token 绝不通过 HTTP 发送。
- `/readyz` 返回 `200` 而 `/v1/catalog` 返回 `403 origin_rejected`：说明数据监听器绑在回环地址上却位于 TLS 前端之后，参见上文“为数据监听器提供 TLS”。
- 浏览器 logout/expiry 只影响会话，不会吊销数据密钥。
- `tailscale serve reset` 会删除节点上的所有映射，请先查看 `tailscale serve status`。
