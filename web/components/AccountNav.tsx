"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ACCOUNT_LINKS, isExactCurrentPath } from "@/lib/nav";

export function AccountNav() {
  const path = usePathname();

  return (
    <nav className="account-nav" aria-label="Account">
      <ul>
        {ACCOUNT_LINKS.map((link) => (
          <li key={link.href}>
            <Link href={link.href} aria-current={isExactCurrentPath(path, link.href) ? "page" : undefined}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
