import type { Metadata, Viewport } from "next";
import { Geist, Noto_Sans_KR } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const notoSansKr = Noto_Sans_KR({
  variable: "--font-noto-kr",
  subsets: ["latin"],
});

/**
 * Derived, not hardcoded: Vercel sets this to the project's production domain,
 * so renaming the project cannot silently break the Open Graph image URL.
 */
const SITE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";
const TITLE = "오늘비 — 내 위치의 오늘·내일 비 예보";
const DESCRIPTION =
  "내 위치의 오늘·내일 비 예보를 날씨 서비스별로 비교하고, 가까운 관측소의 최근 관측 성능을 반영합니다.";

export const metadata: Metadata = {
  // Required for the Open Graph image URL to resolve absolutely; without it a
  // shared link previews with no image at all.
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "오늘비",
  openGraph: {
    type: "website",
    siteName: "오늘비",
    locale: "ko_KR",
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#04060d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${geistSans.variable} ${notoSansKr.variable}`}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
