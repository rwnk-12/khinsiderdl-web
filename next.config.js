const nextConfig = {
  reactStrictMode: true,

  images: {
    localPatterns: [
      {
        pathname: '/api/image',
      },
    ],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'khinsider.com',
      },
      {
        protocol: 'https',
        hostname: 'downloads.khinsider.com',
      },
      {
        protocol: 'https',
        hostname: 'images.khinsider.com',
      },
      {
        protocol: 'https',
        hostname: 'soundtracks.khinsider.com',
      },
      {
        protocol: 'https',
        hostname: 'vgmsite.com',
      },
      {
        protocol: 'https',
        hostname: 'vgmtreasurechest.com',
      },
      {
        protocol: 'https',
        hostname: '**.vgmsite.com',
      },
      {
        protocol: 'https',
        hostname: '**.vgmtreasurechest.com',
      },
    ],
    formats: ['image/avif', 'image/webp'],
    qualities: [60, 75, 85, 90],
  },

  async redirects() {
    return [
      {
        source: '/',
        destination: '/home',
        permanent: true,
      },
      {
        source: '/game-soundtracks',
        destination: '/browse',
        permanent: true,
      },
      {
        source: '/game-soundtracks/year/:year(\\d{4})',
        destination: '/browse?section=year&slug=:year',
        permanent: true,
      },
      {
        source: '/game-soundtracks/gamerips',
        destination: '/browse?section=type&slug=gamerips',
        permanent: true,
      },
      {
        source: '/game-soundtracks/ost',
        destination: '/browse?section=type&slug=ost',
        permanent: true,
      },
      {
        source: '/game-soundtracks/singles',
        destination: '/browse?section=type&slug=singles',
        permanent: true,
      },
      {
        source: '/game-soundtracks/arrangements',
        destination: '/browse?section=type&slug=arrangements',
        permanent: true,
      },
      {
        source: '/game-soundtracks/remixes',
        destination: '/browse?section=type&slug=remixes',
        permanent: true,
      },
      {
        source: '/game-soundtracks/compilations',
        destination: '/browse?section=type&slug=compilations',
        permanent: true,
      },
      {
        source: '/game-soundtracks/inspired-by',
        destination: '/browse?section=type&slug=inspired-by',
        permanent: true,
      },
      {
        source: '/top40',
        destination: '/browse?section=top40',
        permanent: true,
      },
      {
        source: '/all-time-top-100',
        destination: '/browse?section=top1000_all_time',
        permanent: true,
      },
      {
        source: '/last-6-months-top-100',
        destination: '/browse?section=top100_last_6_months',
        permanent: true,
      },
      {
        source: '/top-100-newly-added',
        destination: '/browse?section=top100_newly_added',
        permanent: true,
      },
      {
        source: '/currently-viewed',
        destination: '/browse?section=currently_viewed',
        permanent: true,
      },
      {
        source: '/most-favorites',
        destination: '/browse?section=most_favorites',
        permanent: true,
      },
      {
        source: '/request/list',
        destination: '/browse?section=requests',
        permanent: true,
      },
      {
        source: '/browse/year/:year(\\d{4})',
        destination: '/browse?section=year&slug=:year',
        permanent: true,
      },
      {
        source: '/browse/type/:slug(gamerips|ost|singles|arrangements|remixes|compilations|inspired-by)',
        destination: '/browse?section=type&slug=:slug',
        permanent: true,
      },
      {
        source: '/browse/top40',
        destination: '/browse?section=top40',
        permanent: true,
      },
      {
        source: '/browse/top1000-all-time',
        destination: '/browse?section=top1000_all_time',
        permanent: true,
      },
      {
        source: '/playlist',
        destination: '/playlists',
        permanent: true,
      },
      {
        source: '/playlist/:identifier',
        destination: '/playlists/:identifier',
        permanent: true,
      },
      {
        source: '/playlist/shared',
        destination: '/playlists/shared',
        permanent: true,
      },
      {
        source: '/playlist/shared/:shareId',
        destination: '/playlists/shared/:shareId',
        permanent: true,
      },
    ];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
