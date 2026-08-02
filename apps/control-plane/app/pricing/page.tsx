import type { Metadata } from "next";
import MarketingSite from "../../components/marketing-site";

export const metadata: Metadata = { title: "套餐价格 | infNet", description: "按 CDN 流量和 FRP 隧道资源选择适合你的套餐。" };

export default function PricingPage() {
  return <MarketingSite page="pricing" />;
}
