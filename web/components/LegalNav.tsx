"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isCurrentPath } from "@/lib/nav";

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
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link href={link.href} aria-current={isCurrentPath(path, link.href) ? "page" : undefined}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
