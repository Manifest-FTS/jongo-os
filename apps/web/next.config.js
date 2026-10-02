/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: []
  },
  async redirects() {
    return [
      // The hosting page is the homepage now; keep old links and bookmarks working.
      {
        source: '/hosting',
        destination: '/',
        permanent: true
      },
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
