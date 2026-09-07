import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,PATCH,DELETE,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version" },
        ],
      },
      {
        source: "/mcp",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,DELETE,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version" },
          { key: "Access-Control-Expose-Headers", value: "Mcp-Session-Id, Mcp-Protocol-Version" },
        ],
      },
    ];
  },
};

export default nextConfig;
