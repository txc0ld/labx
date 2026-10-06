export type PartnerOffer = {
  slug: "fantom-labs" | "seatmap";
  partner: string;
  benefit: string;
  website: string;
  websiteLabel: string;
};

export const PARTNER_OFFERS: PartnerOffer[] = [
  {
    slug: "fantom-labs",
    partner: "Fantom Labs",
    benefit: "5% off any Fantom Labs service",
    website: "https://www.fantomlabs.io/",
    websiteLabel: "Visit the Fantom Labs website"
  },
  {
    slug: "seatmap",
    partner: "SeatMap",
    benefit: "5% off SeatMap Pro membership",
    website: "https://seatmap.app/pro",
    websiteLabel: "Visit SeatMap Pro"
  }
];

export function partnerOffer(slug: PartnerOffer["slug"]) {
  return slug === "fantom-labs" ? PARTNER_OFFERS[0] : PARTNER_OFFERS[1];
}
