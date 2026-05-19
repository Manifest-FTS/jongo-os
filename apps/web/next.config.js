/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: []
  },
  async redirects() {
    return [
      {
        source: '/sites',
        destination: '/apps',
        permanent: true
      },
      {
        source: '/sites/:path*',
        destination: '/apps/:path*',
        permanent: true
      }
    ]
  }
}

module.exports = nextConfig
