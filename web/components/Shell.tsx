"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BenchProvider } from "@/lib/bench";
import { isCurrentPath } from "@/lib/nav";
import { OPERATOR, OPERATOR_LINE, publicSiteHost } from "@/lib/operator";
import { MotionOrchestrator } from "./MotionOrchestrator";
import { CursorTrail } from "./CursorTrail";

const LINKS = [
  { href: "/", label: "Explore" },
  { href: "/fairness", label: "Fairness" },
  { href: "/seller", label: "Studio" },
  { href: "/profile", label: "Profile" }
];

const FOOTER_LINKS = [
  { href: "/about", label: "About" },
  { href: "/fairness", label: "Fairness" },
  { href: "/rules", label: "Draw rules" },
  { href: "/legal", label: "Terms" },
  { href: "/privacy", label: "Privacy" }
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <BenchProvider>
      <MotionOrchestrator />
      <CursorTrail />
      <a className="skip" href="#content">Skip to content</a>
      <div className="shell">
        <header className="site-header">
          <Link className="brand" href="/" aria-label="LABx home">
            <Image className="brand-logo" src="/brand/labx-logo.png" alt="LABx" width={1500} height={500} unoptimized priority />
          </Link>
          <Link className="wallet-link" href="/profile" aria-label="Wallet" title="Wallet">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h14a1 1 0 0 0 1-1V8H6a2 2 0 0 1 0-4" />
              <path d="M21 12h-4a2 2 0 0 0 0 4h4" />
              <path d="M17 14h.01" />
            </svg>
          </Link>
          <div className="nav-cluster">
            <nav aria-label="Primary">
              <ul className="nav" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className={link.href === "/" ? "nav-explore" : undefined}
                      aria-current={isCurrentPath(path, link.href) ? "page" : undefined}
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </header>
        <main id="content" tabIndex={-1} className="wrap">{children}</main>
        <footer className="site-footer">
          <div className="footer-strip">
            <strong>{OPERATOR.brand} · {publicSiteHost()}</strong>
            <span>{OPERATOR_LINE}</span>
            <nav aria-label="Footer">
              <ul>
                {FOOTER_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={isCurrentPath(path, link.href) ? "page" : undefined}
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <span>Ethereum Sepolia only. Mainnet is disabled.</span>
          </div>
        </footer>
      </div>
    </BenchProvider>
  );
}
