import type { Metadata } from "next";
import MarketingSite from "../../components/marketing-site";

export const metadata: Metadata = { title: "边缘网络 | infNet", description: "管理你的节点、区域、健康状态与配置同步。" };

export default function NetworkPage() {
  return <MarketingSite page="network" />;
}
