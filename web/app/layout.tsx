import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import { Shell } from "@/components/Shell";
import { publicSiteUrl } from "@/lib/operator";
import "./globals.css";

const sans = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

const site = publicSiteUrl();
const description = "Membership packs for escrowed pieces on Ethereum Sepolia. Bonus entries, Chainlink VRF, Safe treasury.";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#E6D8FA",
  viewportFit: "cover"
};

export const metadata: Metadata = {
  title: { default: "LABx", template: "%s · LABx" },
  description,
  metadataBase: new URL(site),
  icons: { icon: { url: "/favicon.png", type: "image/png", sizes: "32x32" } },
  openGraph: {
    siteName: "LABx",
    title: "LABx",
    description,
    url: site,
    type: "website",
    images: [
      {
        url: "/lab/hero-linked-panels.jpg",
        width: 1200,
        height: 630,
        alt: "Linked laboratory panels, chrome junction, and fluoro cables. No figure."
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "LABx",
    description,
    images: ["/lab/hero-linked-panels.jpg"]
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
