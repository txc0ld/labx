import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"]
  },
  async redirects() {
    return [{ source: "/terms", destination: "/legal", permanent: true }];
  }
};

export default nextConfig;
