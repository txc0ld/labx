export const PRIMARY_LINKS = [
  { href: "/", label: "Explore" },
  { href: "/membership", label: "Membership" },
  { href: "/discounts", label: "Discounts" },
  { href: "/fairness", label: "Fairness" },
  { href: "/seller", label: "Studio" },
  { href: "/profile", label: "Profile" }
];

export const ACCOUNT_LINKS = [
  { href: "/profile", label: "Account" },
  { href: "/membership", label: "Membership" },
  { href: "/discounts", label: "Partner discounts" },
  { href: "/profile/history", label: "History" },
  { href: "/profile/receipts", label: "Receipts" },
  { href: "/profile/history#agreements", label: "Agreements" }
];

export function isCurrentPath(path: string, href: string) {
  if (href === "/") return path === href;
  return path === href || path.startsWith(`${href}/`) || (href === "/legal" && path === "/terms");
}

export function isExactCurrentPath(path: string, href: string) {
  return path === href;
}
