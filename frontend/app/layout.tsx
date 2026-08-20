import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";

// Two faces, loaded through next/font so they are self-hosted and there is no
// render-blocking request to a font CDN.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
});

// IBM Plex Mono carries every numeral in the app. Archivo needs axes: ["wdth"]
// explicitly - next/font ships only the weight axis of a variable font unless the
// others are listed, and without it font-stretch silently does nothing and the
// display face is identical to the body face. Nothing errors.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Trainer",
  description:
    "Deliberate practice for competitive programming. Import your solve history, see where you are actually weak, and get told what to solve next.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexMono.variable} h-full antialiased`}
    >
      {/* AuthProvider wraps everything, including /login and /register. Those
          pages need to know whether a session already exists so they can send
          an already-signed-in visitor straight to the dashboard rather than
          showing them a form they do not need. */}
      <body className="bg-paper text-ink flex min-h-full flex-col">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
