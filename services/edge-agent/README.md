# infNet Edge Agent

```bash
INFNET_CONTROL_URL=https://control.example.com \
INFNET_NODE_TOKEN=issued-node-token \
INFNET_NODE_NAME=shanghai-edge-01 \
INFNET_NODE_REGION=cn-shanghai \
INFNET_NODE_PUBLIC_ADDR=edge.example.com:7443 \
INFNET_TLS_CERT=/etc/infnet/edge.crt \
INFNET_TLS_KEY=/etc/infnet/edge.key \
INFNET_TUNNEL_ADDR=:7443 \
go run .
```

节点只使用平台下发的短期配置。控制面通信使用节点 token 校验；用户隧道端点使用 TLS 1.3 和平台签发的 ticket。正式部署建议以 systemd 服务运行，并限制 agent 的本地文件和网络权限。

没有证书时 agent 默认不会启动隧道端点；仅本地调试可设置 `INFNET_ALLOW_PLAINTEXT=true`。

生产环境的 `INFNET_CONTROL_URL` 必须是 HTTPS；本地 HTTP 控制面调试时额外设置 `INFNET_ALLOW_PLAINTEXT=true`。CDN 内存缓存默认最多 1000 个对象，可用 `INFNET_CDN_MAX_CACHE_ENTRIES` 调整。

`INFNET_NODE_PUBLIC_ADDR` 必须填写用户可访问的公网 `host:port`，并与 `INFNET_TUNNEL_ADDR` 的端口一致。控制面会把它写入隧道客户端配置；未设置时，客户无法生成可连接命令。

如果使用平台 bootstrap token 自动注册，agent 首次注册会交换随机节点 token，并保存到 `INFNET_NODE_STATE_FILE`（默认 `/var/lib/infnet/agent-state.json`）；systemd 单元已配置该目录的最小写权限。之后重启会使用保存的节点身份，不会重复使用 bootstrap token。
