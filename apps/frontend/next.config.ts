import type { NextConfig } from "next";
import path from "path";
import dotenv from "dotenv";

// Load .env from monorepo root (same as backend)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const nextConfig: NextConfig = {
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: '/s/:path*',
        destination: `${backendUrl}/s/:path*`,
      },
    ];
  },
};

export default nextConfig;
