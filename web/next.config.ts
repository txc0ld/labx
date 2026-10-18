import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.LABX_NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  env: { DISABLE_GLOBAL_CORE: "true" },
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"]
  },
  async headers() {
    // Nothing frames LABx, so no other site can overlay its Create, Approve or List buttons.
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" }
      ]
    }];
  },
  async redirects() {
    return [{ source: "/terms", destination: "/legal", permanent: true }];
  }
};

export default nextConfig;
