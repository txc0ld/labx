export function isCurrentPath(path: string, href: string) {
  return path === href || (href === "/legal" && path === "/terms");
}
