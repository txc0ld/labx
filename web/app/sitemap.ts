import type { MetadataRoute } from "next";

const paths = ["/", "/about", "/privacy", "/legal", "/fairness", "/rules", "/seller", "/profile"];

export default function sitemap(): MetadataRoute.Sitemap {
  return paths.map((path) => ({
    url: `https://labx.art${path === "/" ? "" : path}`,
    changeFrequency: path === "/" ? "daily" : "weekly",
    priority: path === "/" ? 1 : 0.6
  }));
}
