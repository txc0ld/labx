"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { BadgePercent, Compass, Layers3, UserRound } from "lucide-react";
import { motion } from "motion/react";
import { isCurrentPath } from "@/lib/nav";

const shortcutLinks = [
  { href: "/", label: "Explore", icon: Compass },
  { href: "/membership", label: "Membership", icon: Layers3 },
  { href: "/discounts", label: "Discounts", icon: BadgePercent },
  { href: "/profile", label: "Profile", icon: UserRound }
] as const;

type FooterProps = {
  legalLinks: ReadonlyArray<{ href: string; label: string }>;
};

export function Footer({ legalLinks }: FooterProps) {
  const path = usePathname();
  const footerLinks = [{ href: "/guide", label: "How it works" }, ...legalLinks];

  return (
    <footer className="site-footer">
      <AnimatedContainer className="footer-nav-wrap">
        <nav aria-label="Footer">
          <ul>
            {footerLinks.map((link) => (
              <li key={link.href}>
                <Link href={link.href} aria-current={isCurrentPath(path, link.href) ? "page" : undefined}>{link.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </AnimatedContainer>

      <AnimatedContainer className="footer-shortcuts" delay={0.1}>
        <nav aria-label="Quick links">
          <ul>
            {shortcutLinks.map((link) => {
              const Icon = link.icon;
              return (
                <li key={link.href}>
                  <Link href={link.href} aria-label={link.label} title={link.label} aria-current={isCurrentPath(path, link.href) ? "page" : undefined}>
                    <Icon aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </AnimatedContainer>

      <AnimatedContainer className="footer-copyright" delay={0.2}>
        <p>© 2026 LABx</p>
      </AnimatedContainer>
    </footer>
  );
}

type AnimatedContainerProps = {
  delay?: number;
  className?: ComponentProps<typeof motion.div>["className"];
  children: ReactNode;
};

function useLiveReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(preference.matches);
    updatePreference();
    preference.addEventListener("change", updatePreference);
    return () => preference.removeEventListener("change", updatePreference);
  }, []);

  return reducedMotion;
}

function AnimatedContainer({ className, delay = 0.1, children }: AnimatedContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasRevealed = useRef(false);
  const reducedMotion = useLiveReducedMotion();
  const [armed, setArmed] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || reducedMotion === null) return;

    if (reducedMotion || hasRevealed.current || !("IntersectionObserver" in window)) {
      hasRevealed.current = true;
      setArmed(false);
      setVisible(true);
      return;
    }

    if (container.getBoundingClientRect().top < window.innerHeight * 0.94) {
      hasRevealed.current = true;
      setArmed(false);
      setVisible(true);
      return;
    }

    setArmed(true);
    setVisible(false);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      hasRevealed.current = true;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "0px 0px -5%", threshold: 0.08 });
    observer.observe(container);
    return () => observer.disconnect();
  }, [reducedMotion]);

  const shown = { filter: "blur(0px)", translateY: 0, opacity: 1 };
  const hidden = { filter: "blur(4px)", translateY: -8, opacity: 0 };
  const animateMotion = armed && reducedMotion === false;

  return (
    <motion.div
      ref={containerRef}
      initial={false}
      animate={animateMotion && !visible ? hidden : shown}
      transition={animateMotion ? { delay: visible ? delay : 0, duration: 0.6, ease: [0.16, 1, 0.3, 1] } : { delay: 0, duration: 0 }}
      className={`footer-animated${className ? ` ${className}` : ""}`}
      onFocusCapture={() => {
        hasRevealed.current = true;
        setArmed(false);
        setVisible(true);
      }}
    >
      {children}
    </motion.div>
  );
}
