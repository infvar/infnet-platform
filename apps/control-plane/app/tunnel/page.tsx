import type { Metadata } from "next";
import MarketingSite from "../../components/marketing-site";

export const metadata: Metadata = { title: "内网穿透 | infNet", description: "用 infNet 自研客户端，把本地服务安全发布到公网。" };

export default function TunnelPage() {
  return <MarketingSite page="tunnel" />;
}
