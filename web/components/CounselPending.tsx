import type { ReactNode } from "react";

/** Mainnet copy that keeps a Sepolia legal characterization until counsel reviews it. LEGAL.md lists each one. */
export function CounselPending({ children }: { children: ReactNode }) {
  return <span className="counsel-pending"><strong>Pending counsel review:</strong> {children}</span>;
}
