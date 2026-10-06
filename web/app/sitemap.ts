import type { MetadataRoute } from "next";
import { publicSiteUrl } from "@/lib/operator";

const paths = [
  "/", "/about", "/guide", "/privacy", "/legal", "/fairness", "/rules",
  "/membership", "/discounts", "/discounts/fantom-labs", "/discounts/seatmap",
  "/eligibility", "/seller", "/profile", "/profile/history", "/profile/receipts"
];

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicSiteUrl();
  return paths.map((path) => ({
    url: `${origin}${path === "/" ? "" : path}`,
    changeFrequency: path === "/" ? "daily" : "weekly",
    priority: path === "/" ? 1 : 0.6
  }));
}
