import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pg ist ein Node-Modul und soll nicht gebündelt werden
  serverExternalPackages: ["pg"],
};

export default nextConfig;
