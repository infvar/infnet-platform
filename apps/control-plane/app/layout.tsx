import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "InfNet Control", description: "CDN and private tunnel operations" };
export const runtime = "edge";
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
