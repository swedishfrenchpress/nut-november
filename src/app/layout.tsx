import type { Metadata } from "next";
import { Archivo, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { DonationsProvider } from "./context/DonationsContext";

// Packet type: one grotesque whose width axis does the work. Regular for
// reading, condensed for labels, expanded for sat amounts.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
});

// Only for typing URLs on the submission form, so it isn't preloaded.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

// Load your custom SauceTM font
const sauceTM = localFont({
  src: "../fonts/SauceTM-Regular.woff2",
  variable: "--font-sauce-tm",
  weight: "400",
  style: "normal",
});

export const metadata: Metadata = {
  title: "Nut November - A month-long hackathon for Cashu builders",
  description: "A month-long hackathon for Cashu builders who just can't hold their nuts.",
  openGraph: {
    title: "Nut November - A month-long hackathon for Cashu builders",
    description: "A month-long hackathon for Cashu builders who just can't hold their nuts.",
    url: "https://nutnovember.org",
    siteName: "Nut November",
    images: [
      {
        url: "https://nutnovember.org/opengraph-2026-v2.jpg",
        width: 2400,
        height: 1260,
        alt: "Nut November 2026, a month-long hackathon for Cashu builders, November 1 to 27",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Nut November - A month-long hackathon for Cashu builders",
    description: "A month-long hackathon for Cashu builders who just can't hold their nuts.",
    images: ["https://nutnovember.org/opengraph-2026-v2.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${archivo.variable} ${geistMono.variable} ${sauceTM.variable} antialiased`}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-bark focus:px-5 focus:py-3 focus:font-bold focus:text-cream"
        >
          Skip to content
        </a>
        <DonationsProvider>
          {children}
        </DonationsProvider>
      </body>
    </html>
  );
}
