import type { Metadata, Viewport } from "next";
import { Geist, Noto_Sans_Bengali } from "next/font/google";
import "./globals.css";

const geist = Geist({ variable: "--font-latin", subsets: ["latin"] });
const notoBengali = Noto_Sans_Bengali({ variable: "--font-bengali", subsets: ["bengali"] });

export const metadata: Metadata = {
  title: "Bangla Rider · Gulshan",
  description: "Pick two places in Gulshan, Dhaka and see the road route, distance, time and turn-by-turn directions.",
  applicationName: "Bangla Rider",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#006a4e",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} ${notoBengali.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
