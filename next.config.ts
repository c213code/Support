import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ssh2 грузит .node/crypto-ассеты, которые Turbopack не умеет упаковывать
  // в ESM-чанк — держим его вне бандла, требуется только в /api/vpn-service.
  serverExternalPackages: ["ssh2"],
};

export default nextConfig;
