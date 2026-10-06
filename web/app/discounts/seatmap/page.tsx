import type { Metadata } from "next";
import { OfferDetail } from "@/components/OfferDetail";
import { partnerOffer } from "@/lib/offers";

export const metadata: Metadata = { title: "SeatMap Pro discount" };

export default function SeatMapOfferPage() {
  const offer = partnerOffer("seatmap");
  return <OfferDetail offer={offer} />;
}
