import type { Metadata } from "next";
import MarketingSite from "../../components/marketing-site";

export const metadata: Metadata = { title: "平台能力 | infNet", description: "用同一批边缘节点，独立运行 CDN 分发与 FRP 内网穿透。" };

export default function PlatformPage() {
  return <MarketingSite page="platform" />;
}
