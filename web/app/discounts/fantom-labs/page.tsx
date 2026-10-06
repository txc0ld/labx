import type { Metadata } from "next";
import { OfferDetail } from "@/components/OfferDetail";
import { partnerOffer } from "@/lib/offers";

export const metadata: Metadata = { title: "Fantom Labs discount" };

export default function FantomLabsOfferPage() {
  const offer = partnerOffer("fantom-labs");
  return <OfferDetail offer={offer} />;
}
