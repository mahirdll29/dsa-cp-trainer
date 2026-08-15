import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";

// ---------------------------------------------------------------------------
// TYPE — three roles, two families. Full reasoning in
// .claude/skills/trainer-design/SKILL.md; the short version:
//
// ARCHIVO carries both display and body. It is a variable font with a WIDTH
// axis, and this project uses that axis as the entire separation between the
// two roles — display is the same face at wdth 125, body at wdth 100. That is
// the typographic analogue of the colour law: one system, varied only where the
// variation means something. It also costs one font download instead of two.
//
// Why a wide grotesque at all: this app is a private version of a contest
// standings page, and wide grotesques are the vernacular of scoreboards. A
// serif display would have landed in the cream/serif look this project is
// explicitly avoiding.
//
// `axes: ["wdth"]` is REQUIRED. next/font ships only the weight axis of a
// variable font unless other axes are named, so without it `font-stretch: 125%`
// would silently do nothing and the display face would be indistinguishable
// from the body face.
// ---------------------------------------------------------------------------
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
});

// IBM PLEX MONO carries every numeral in the app. Drawn for engineering
// documentation, it has true tabular figures and a slashed zero — both of which
// are functional here rather than decorative, because this interface asks people
// to read columns of scores and ratings at 11-13px.
//
// It is NOT a variable font, so the weights actually used must be listed. Three
// are: 400 for data rows, 500 for the small caps-y labels, 600 for emphasis.
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
