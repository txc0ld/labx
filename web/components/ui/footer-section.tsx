"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { BadgePercent, CircleDot, Compass, FlaskConical } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { isCurrentPath } from "@/lib/nav";
import { OPERATOR, OPERATOR_LINE, publicSiteHost } from "@/lib/operator";

const footerSections = [
  {
    label: "Discover",
    icon: Compass,
    links: [
      { title: "Explore", href: "/" },
      { title: "Membership", href: "/membership" },
      { title: "How it works", href: "/guide" }
    ]
  },
  {
    label: "Benefits",
    icon: BadgePercent,
    links: [
      { title: "Partner discounts", href: "/discounts" },
      { title: "Eligibility", href: "/eligibility" },
      { title: "Profile", href: "/profile" }
    ]
  },
  {
    label: "Process",
    icon: FlaskConical,
    links: [
      { title: "Fairness", href: "/fairness" },
      { title: "Studio", href: "/seller" },
      { title: "About LABx", href: "/about" }
    ]
  }
] as const;

type FooterProps = {
  legalLinks: ReadonlyArray<{ href: string; label: string }>;
};

export function Footer({ legalLinks }: FooterProps) {
  const path = usePathname();

  return (
    <footer className="site-footer">
      <div className="footer-glow" aria-hidden="true" />
      <div className="footer-main">
        <AnimatedContainer className="footer-identity">
          <Link className="footer-brand" href="/" aria-label="LABx home">
            <Image src="/brand/labx-logo.png" alt="LABx" width={1500} height={500} unoptimized />
          </Link>
          <p>Membership packs for escrowed pieces.</p>
          <span className="footer-network"><CircleDot aria-hidden="true" /> Ethereum Sepolia only</span>
        </AnimatedContainer>

        <nav className="footer-directory" aria-label="Site directory">
          {footerSections.map((section, index) => {
            const Icon = section.icon;
            return (
              <AnimatedContainer className="footer-link-group" delay={0.1 + index * 0.1} key={section.label}>
                <h2><Icon aria-hidden="true" />{section.label}</h2>
                <ul>
                  {section.links.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href} aria-current={isCurrentPath(path, link.href) ? "page" : undefined}>{link.title}</Link>
                    </li>
                  ))}
                </ul>
              </AnimatedContainer>
            );
          })}
        </nav>
      </div>

      <AnimatedContainer className="footer-bottom" delay={0.4}>
        <div className="footer-operator">
          <strong>{OPERATOR.brand} · {publicSiteHost()}</strong>
          <span>{OPERATOR_LINE}</span>
        </div>
        <nav aria-label="Footer">
          <ul>
            {legalLinks.map((link) => (
              <li key={link.href}>
                <Link href={link.href} aria-current={isCurrentPath(path, link.href) ? "page" : undefined}>{link.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <span className="footer-disclosure">Mainnet is disabled.</span>
      </AnimatedContainer>
    </footer>
  );
}

type AnimatedContainerProps = {
  delay?: number;
  className?: ComponentProps<typeof motion.div>["className"];
  children: ReactNode;
};

function AnimatedContainer({ className, delay = 0.1, children }: AnimatedContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasRevealed = useRef(false);
  const shouldReduceMotion = useReducedMotion();
  const [armed, setArmed] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || shouldReduceMotion || hasRevealed.current || !("IntersectionObserver" in window)) {
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
  }, [shouldReduceMotion]);

  const shown = { filter: "blur(0px)", translateY: 0, opacity: 1 };
  const hidden = { filter: "blur(4px)", translateY: -8, opacity: 0 };
  const animateMotion = armed && !shouldReduceMotion;

  return (
    <motion.div
      ref={containerRef}
      initial={false}
      animate={animateMotion && !visible ? hidden : shown}
      transition={animateMotion ? { delay: visible ? delay : 0, duration: 0.8, ease: [0.16, 1, 0.3, 1] } : { delay: 0, duration: 0 }}
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
