import type { Metadata } from "next";
import { LiveOwnerReviewQueue } from "@/components/review/OwnerReview";

export const metadata: Metadata = { title: "Raffle review" };

export default function ReviewQueuePage() {
  return (
    <section className="section stack page-frame">
      <p className="kicker">LABx owner review</p>
      <h1 className="page-title">Review the exact draft before approval.</h1>
      <p className="lede">Each approval binds one draft revision, NFT identity, custody check and opening policy. Draft changes require a new review.</p>
      <LiveOwnerReviewQueue />
    </section>
  );
}
