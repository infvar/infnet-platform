# infNet Client

这是 infNet 自有客户端，不依赖公开 `frpc`。当前版本完成 TLS 1.3、短期 ticket 握手，以及公开端口到本地服务的双向 TCP 转发。

```bash
INFNET_SERVER=edge.example.com:7443 INFNET_TICKET=... go run . -local 127.0.0.1:8080 -name app
```

客户端会自动重连；生产连接默认要求 TLS 1.3。仅在本地测试明文 agent 时使用 `-plaintext`，测试自签名证书时可临时使用 `-insecure`。
生产环境可使用 `-ca /etc/infnet/edge-ca.pem` 或 `INFNET_CA_FILE` 指定私有 CA；隧道 ticket 默认 24 小时后过期。

客户控制台的“客户端配置”按钮会生成包含服务端、ticket、隧道名称和本地地址的命令。请把命令运行在能访问本地业务端口的机器上，不要把 ticket 提交到代码仓库或日志系统。
