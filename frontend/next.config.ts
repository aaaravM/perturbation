import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // three.js ships modern ESM; transpile it so drei/fiber share one copy and build cleanly.
  transpilePackages: ["three"],
  // Retired pages: the list of finds moved from Discoveries to the AI page, and Help the search is
  // gone. Exact paths only, so the data under /discoveries/ (candidates.json, stamps) is still served.
  async redirects() {
    return [
      { source: "/discoveries", destination: "/ai", permanent: true },
      { source: "/help", destination: "/ai", permanent: true },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
