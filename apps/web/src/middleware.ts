import { withAuth } from 'next-auth/middleware';

export default withAuth({ pages: { signIn: '/login' } });

// Marketing, auth pages, the proxy (it does its own 401s) and static assets stay public.
export const config = {
  matcher: ['/dashboard/:path*', '/surveys/:path*', '/contacts/:path*', '/settings/:path*', '/billing/:path*', '/onboarding/:path*', '/simulator/:path*', '/integrations/:path*'],
};
