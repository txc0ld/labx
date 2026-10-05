import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Not on the bench",
  description: "That LABx route is empty. Return to the Sepolia explore hub."
};

export default function NotFound() {
  return (
    <section className="section stack">
      <p className="kicker">Off the bench</p>
      <h1 className="page-title">This panel is not wired.</h1>
      <article className="pearl pad stack">
        <p>That route is empty. The explore hub, fairness locks, and legal pages are still on the bench.</p>
        <div className="btn-row">
          <Link className="btn" href="/">Explore the bench</Link>
          <Link className="btn btn-dark" href="/fairness">Fairness</Link>
          <Link className="btn btn-dark" href="/about">About</Link>
        </div>
      </article>
    </section>
  );
}
