import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const appDir = path.dirname(fileURLToPath(import.meta.url));
const nextConfig = {
  typedRoutes: true,
  turbopack: { root: path.resolve(appDir, "../..") },
};
export default nextConfig;
