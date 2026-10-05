"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BenchProvider } from "@/lib/bench";
import { isCurrentPath } from "@/lib/nav";
import { OPERATOR, OPERATOR_LINE, publicSiteHost } from "@/lib/operator";
import { MotionOrchestrator } from "./MotionOrchestrator";

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
      <a className="skip" href="#content">Skip to content</a>
      <div className="shell">
        <header className="site-header">
          <Link className="brand" href="/">
            <span className="brand-mark" aria-hidden="true" />
            <span className="word">LAB<i>x</i></span>
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
            <span className="chain-pill">Sepolia · USDC</span>
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
