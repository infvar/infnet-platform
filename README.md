# infNet

CDN + FRP 分发平台。控制面采用 NextJS App Router，节点程序和用户客户端采用 Go；节点控制面通信为 HTTPS + JSON，用户隧道使用 infNet 自有协议，节点只执行平台签发的配置。

## 本地启动

```bash
npm install
npm run dev
```

打开 http://localhost:3000。生产环境必须设置 Neon 或其他支持 Serverless/HTTP 的 PostgreSQL 连接串；控制面运行在 Edge runtime，不能使用本机 TCP PostgreSQL。数据库会在首次请求时自动创建表、索引、默认套餐并补齐兼容迁移，不需要单独运行 migration 容器。

```bash
DATABASE_URL='postgresql://user:password@ep-example.us-east-2.aws.neon.tech/infnet?sslmode=require'
INFNET_ADMIN_TOKEN='replace-me' \
INFNET_ADMIN_OPERATOR_TOKEN='replace-operator-token' \
INFNET_ADMIN_VIEWER_TOKEN='replace-viewer-token' \
INFNET_NODE_BOOTSTRAP_TOKEN='one-time-bootstrap' \
DATABASE_URL="$DATABASE_URL" npm run start
```

管理员凭证角色：`INFNET_ADMIN_TOKEN` 为 owner，`INFNET_ADMIN_OPERATOR_TOKEN` 可管理套餐、节点和隧道，`INFNET_ADMIN_VIEWER_TOKEN` 只读。登录后控制面使用数据库中的短期 HttpOnly session。

生产 compose 启动：

```bash
cp .env.example .env
# 编辑 .env，填入随机长密钥
docker compose up -d --build
```

Compose 只运行无状态控制面并连接外部 Neon/Serverless PostgreSQL；首次请求会自动获取数据库 advisory lock、创建表/索引/默认套餐并补齐兼容字段，不需要 migration 容器或手工执行 SQL。生产 Compose 同时要求配置 Upstash Redis REST，用于多实例限流；未配置时仅使用单实例内存限流，仅适合本地开发。

上线前检查：

```bash
curl -fsS https://control.example.com/api/health
```

生产模式要求 PostgreSQL 已配置且可用；若配置 Upstash，健康接口也会检查该限流依赖。edge-agent 只会确认成功应用的配置命令，失败命令会在控制面租约超时后自动重试。
外部 PostgreSQL 默认启用 TLS 证书校验；只有明确使用非 TLS 数据库时才设置 `DATABASE_SSL=false`，私有 CA 通过 `DATABASE_SSL_CA` 注入。Edge 运行时不能连接本机 TCP PostgreSQL。

## 目录

- `apps/control-plane`: 用户/管理员控制台与 `/api/v1` API
- `services/edge-agent`: 部署到边缘服务器，注册节点、拉取签名配置、管理 CDN/FRP worker
- `clients/infnet-client`: 用户侧私有 FRP 客户端，通过控制面获取短期隧道凭证

统一构建命令为 `make build`，产物写入 `dist/`；Linux 节点可使用 `sudo deploy/install-edge-agent.sh` 安装 systemd 服务，完整上线清单见 `deploy/README.md`。

## 节点运行

管理员在控制台创建节点后获得一次性 `token`。节点启动时设置：

```bash
INFNET_CONTROL_URL=https://control.example.com \
INFNET_NODE_TOKEN='issued-node-token' \
INFNET_NODE_NAME=shanghai-edge-01 \
INFNET_NODE_REGION=cn-shanghai \
INFNET_NODE_PUBLIC_ADDR=edge.example.com:7443 \
INFNET_TLS_CERT=/etc/infnet/edge.crt \
INFNET_TLS_KEY=/etc/infnet/edge.key \
INFNET_TUNNEL_ADDR=:7443 \
go run ./services/edge-agent
```

也可以让 agent 使用 `INFNET_NODE_BOOTSTRAP_TOKEN` 自动注册未预配节点。首次注册响应会交换随机节点 token，agent 保存到 `/var/lib/infnet/agent-state.json`；后续重启使用保存的 node ID/token，不会继续使用 bootstrap token。

本地无证书调试时才额外设置 `INFNET_ALLOW_PLAINTEXT=true`，并让客户端使用 `-plaintext`。该变量也只允许 edge-agent 使用 HTTP 连接本地开发控制面；生产节点缺少 TLS 证书或控制面 HTTPS 会拒绝启动。生产 CDN 缓存默认最多 1000 个对象，可通过 `INFNET_CDN_MAX_CACHE_ENTRIES` 调整。

隧道命令会由 agent 轮询领取，节点在远端端口监听后等待自研客户端会话。客户端使用 `-plaintext` 仅用于本地开发；生产环境必须配置 TLS 证书并使用 TLS 连接：

```bash
go build -o /usr/local/bin/infnet-client ./clients/infnet-client
# 在客户控制台“客户端配置”复制该隧道的命令，或手工填写以下变量
INFNET_SERVER=edge.example.com:7443 \
INFNET_TICKET='short-lived-ticket' \
/usr/local/bin/infnet-client -name app -local 127.0.0.1:8080
```

`INFNET_NODE_PUBLIC_ADDR` 是用户客户端实际连接的公网 `host:port`，不是 CDN HTTP 地址；节点防火墙需要放行 `INFNET_TUNNEL_ADDR` 对应端口。agent 会在注册和每次心跳上报该地址，修改地址后新生成的客户端配置会使用最新值。客户端配置接口只返回当前用户自己的隧道，节点未上报公网地址时会返回 409，避免生成不可用命令。

自动初始化覆盖套餐、用户/session、订单、节点、节点 token、隧道 ticket、CDN 路由、审计日志、agent 命令队列和月度用量计数；未指定节点的 CDN 路由会下发到所有在线 CDN 节点，后续节点恢复在线后仍会领取未完成命令。

节点每次成功心跳会上报自上次心跳以来的 CDN 响应和 FRP 双向字节数，控制面按资源所属套餐按月聚合，并用 `usageReportId` 做幂等去重。创建新隧道或 CDN 路由前会检查该套餐的流量额度；客户控制台的“本月用量”显示累计量和超额状态。计量是数据面实际转发字节，开发模式和 PostgreSQL 模式都遵循同一上报协议。

节点注册和每次心跳都会执行 desired-state 同步：新上线节点会自动领取已有的可部署 CDN 路由；重新注册的 FRP 节点会恢复分配给它的隧道。同步按资源 ID 和命令类型幂等，不会因为重复心跳堆积命令。

超过额度后，该套餐下的现有隧道和 CDN 路由会进入 `suspended`，控制面向节点发送移除命令；进入新的 UTC 计费月后，节点心跳会重新下发这些资源。用户仍可删除暂停资源。

支付默认使用带 HMAC 校验的 provider-neutral webhook，适合接入自有收银台。需要真实收银台时设置 `INFNET_PAYMENT_PROVIDER=stripe`、`INFNET_PUBLIC_URL`、`STRIPE_SECRET_KEY` 和 `STRIPE_WEBHOOK_SECRET`；用户下单会跳转 Stripe Checkout，`checkout.session.completed` 才会把订单标记为已支付。不要在客户端或仓库中暴露任何 Stripe 密钥。正式商业上线仍需配置证书自动轮换和 CDN 监控/缓存失效编排。
