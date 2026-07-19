import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "Probe Atlas · 分布式服务器监控",
    description: "轻量、实时的多节点服务器运行状态监控面板。",
    openGraph: {
      title: "Probe Atlas",
      description: "分布式服务器监控",
      images: [{ url: `${origin}/og.png`, width: 1736, height: 907 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Probe Atlas",
      description: "分布式服务器监控",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
