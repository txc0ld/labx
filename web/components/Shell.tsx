"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BenchProvider } from "@/lib/bench";
import { Plumbing } from "./Plumbing";

const LINKS = [
  { href: "/", label: "Explore" },
  { href: "/fairness", label: "Fairness" },
  { href: "/seller", label: "Studio" },
  { href: "/profile", label: "Profile" }
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <BenchProvider>
      <a className="skip" href="#content">Skip to content</a>
      <p className="field-mark" aria-hidden="true">LAB</p>
      <div className="shell">
        <header className="site-header">
          <Link className="brand" href="/">
            <span className="brand-mark" aria-hidden="true" />
            <span className="word">LAB<i>x</i></span>
          </Link>
          <nav aria-label="Primary">
            <ul className="nav" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} aria-current={path === link.href ? "page" : undefined}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <span className="chain-pill">Sepolia · USDC</span>
        </header>
        <div className="wrap"><Plumbing /></div>
        <main id="content" tabIndex={-1} className="wrap">{children}</main>
        <footer className="site-footer">
          <Plumbing label="Footer cable run" />
          <strong>LABx · labx.art</strong>
          <span>Fantom Labs Pty Ltd · ABN 56 702 056 166 · ACN 702 056 166</span>
          <nav aria-label="Footer">
            <Link href="/fairness">Fairness</Link>
            <Link href="/rules">Draw rules</Link>
            <Link href="/legal">Terms</Link>
          </nav>
          <span>Ethereum Sepolia only. Mainnet is disabled.</span>
        </footer>
      </div>
    </BenchProvider>
  );
}
