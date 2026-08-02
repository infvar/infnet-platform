import type { Metadata } from "next";
import MarketingSite from "../../components/marketing-site";

export const metadata: Metadata = { title: "开发者文档 | infNet", description: "接入 edge-agent、配置 CDN 路由和发布 FRP 隧道。" };

export default function DocsPage() {
  return <MarketingSite page="docs" />;
}
