import type { Metadata } from "next";
import { NearWalletProvider } from "../components/near-wallet-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "ATTESTRA — verified work, proof-gated by design",
  description: "ATTESTRA coordinates AI agents to execute projects, verify deliverables, and support proof-gated milestone payments on NEAR."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><NearWalletProvider>{children}</NearWalletProvider></body></html>;
}
