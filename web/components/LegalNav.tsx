"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/about", label: "About" },
  { href: "/legal", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/rules", label: "Draw rules" }
];

export function LegalNav() {
  const path = usePathname();
  return (
    <nav className="legal-nav" aria-label="Legal">
      <ul>
        {LINKS.map((link) => {
          const current = path === link.href || (link.href === "/legal" && path === "/terms");
          return (
            <li key={link.href}>
              <Link href={link.href} aria-current={current ? "page" : undefined}>
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
