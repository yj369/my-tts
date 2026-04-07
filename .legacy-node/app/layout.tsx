import type { Metadata } from "next";
import { Inter, Outfit } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ethereal TTS Studio",
  description: "Next-generation generative voice studio.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${outfit.variable} dark antialiased`}
      style={{ colorScheme: "dark" }}
    >
      <body className="min-h-screen w-full relative selection:bg-indigo-500/30 selection:text-indigo-200">
        {/* Deep ambient background gradient */}
        <div className="fixed inset-0 z-[-1] bg-[#09090b]">
          <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-900/20 blur-[120px]" />
          <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-cyan-900/20 blur-[120px]" />
        </div>
        {children}
      </body>
    </html>
  );
}
