import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./indexTTS.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-index-sans",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-index-mono",
});

export default function IndexTTSLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <section
      className={`${spaceGrotesk.variable} ${ibmPlexMono.variable} index-tts-shell`}
    >
      {children}
    </section>
  );
}
