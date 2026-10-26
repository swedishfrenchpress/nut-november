import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Donations to Nut November",
  description: "Every donation to the Nut November 2026 prize pool.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
