import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ChatBrain — your personal second brain",
  description:
    "Upload PDFs, paste text, or drop in URLs and chat with an AI grounded in your own knowledge base.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="relative min-h-full flex flex-col">
        {/* Fixed grain overlay — adds texture so the dark canvas never feels
            flat. Purely decorative, pointer-events: none. */}
        <div aria-hidden className="noise-bg" />
        <div className="relative z-[1] flex min-h-screen flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
