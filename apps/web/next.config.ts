import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, '../..'),
  transpilePackages: [
    '@aihd/domain',
    '@aihd/ai',
    '@aihd/api-client',
    '@aihd/db',
    '@aihd/ui',
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
};

export default nextConfig;
