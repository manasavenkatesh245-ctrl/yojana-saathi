import type { Metadata, Viewport } from "next";
import {
  Atkinson_Hyperlegible, IBM_Plex_Mono, Noto_Sans_Bengali, Noto_Sans_Devanagari, Noto_Sans_Gujarati, Noto_Sans_Gurmukhi,
  Noto_Sans_Kannada, Noto_Sans_Malayalam, Noto_Sans_Tamil, Noto_Sans_Telugu, Source_Serif_4,
} from "next/font/google";
import "./globals.css";

const sans = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-sans", display: "swap" });
const serif = Source_Serif_4({ subsets: ["latin"], weight: ["600"], variable: "--font-serif", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });
const deva = Noto_Sans_Devanagari({ subsets: ["devanagari"], weight: ["400", "700"], variable: "--font-deva", display: "swap" });
// Other Indic scripts: not preloaded; the browser fetches each only when that script appears (unicode-range).
// next/font needs literal options per call, hence the repetition.
const beng = Noto_Sans_Bengali({ subsets: ["bengali"], weight: ["400", "700"], variable: "--font-beng", display: "swap", preload: false });
const telu = Noto_Sans_Telugu({ subsets: ["telugu"], weight: ["400", "700"], variable: "--font-telu", display: "swap", preload: false });
const taml = Noto_Sans_Tamil({ subsets: ["tamil"], weight: ["400", "700"], variable: "--font-taml", display: "swap", preload: false });
const gujr = Noto_Sans_Gujarati({ subsets: ["gujarati"], weight: ["400", "700"], variable: "--font-gujr", display: "swap", preload: false });
const knda = Noto_Sans_Kannada({ subsets: ["kannada"], weight: ["400", "700"], variable: "--font-knda", display: "swap", preload: false });
const mlym = Noto_Sans_Malayalam({ subsets: ["malayalam"], weight: ["400", "700"], variable: "--font-mlym", display: "swap", preload: false });
const guru = Noto_Sans_Gurmukhi({ subsets: ["gurmukhi"], weight: ["400", "700"], variable: "--font-guru", display: "swap", preload: false });

export const metadata: Metadata = {
  title: "Yojana Saathi · Government scheme agent",
  description: "Describe your situation in your own words, in 10 Indian languages. Yojana Saathi checks 27 central government schemes, explains what you qualify for and why, and drafts the application.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f0e6" },
    { media: "(prefers-color-scheme: dark)", color: "#14120e" },
  ],
};

const fonts = [sans, serif, mono, deva, beng, telu, taml, gujr, knda, mlym, guru].map((f) => f.variable).join(" ");

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fonts}>
      <body>{children}</body>
    </html>
  );
}
