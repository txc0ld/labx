import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found",
  description: "The requested LABx page is not available."
};

export default function NotFound() {
  return (
    <section className="section stack missing-state">
      <p className="kicker">404</p>
      <h1 className="page-title">Page not found.</h1>
      <article className="pearl pad stack">
        <p>The requested page is not available.</p>
        <div className="btn-row">
          <Link className="btn" href="/">Return to the collection</Link>
          <Link className="btn btn-dark" href="/discounts">View partner discounts</Link>
        </div>
      </article>
    </section>
  );
}
