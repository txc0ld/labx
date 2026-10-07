import type { Metadata } from "next";
import { LiveOwnerReviewDetail } from "@/components/review/OwnerReview";

export const metadata: Metadata = { title: "Review raffle draft" };

export default async function ReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveOwnerReviewDetail id={id} />;
}
