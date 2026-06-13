// flowboard-frontend-spa-proxy
// Routes app.flowboard.bond → Cloudflare Pages (main branch alias)
// The `main.flowboard-frontend.pages.dev` alias always tracks the latest
// production build deployed from the `main` branch.

const PAGES_ORIGIN = 'https://main.flowboard-frontend.pages.dev';

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const url = new URL(request.url);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Not found', {
      status: 404,
      headers: { 'x-flowboard-spa-proxy': 'miss' },
    });
  }

  // Static assets — proxy directly to Pages origin
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/downloads/')) {
    const targetUrl = new URL(url.pathname + url.search, PAGES_ORIGIN);
    const response = await fetch(targetUrl.toString(), {
      headers: { 'User-Agent': request.headers.get('User-Agent') || '' },
      cf: { cacheEverything: false },
    });
    const newHeaders = new Headers(response.headers);
    newHeaders.set('x-flowboard-spa-proxy', 'asset');
    return new Response(response.body, { status: response.status, headers: newHeaders });
  }

  // Static files at root (icon.svg, _redirects, etc.)
  if (url.pathname !== '/' && !url.pathname.startsWith('/project/') && url.pathname.includes('.')) {
    const targetUrl = new URL(url.pathname + url.search, PAGES_ORIGIN);
    const response = await fetch(targetUrl.toString(), {
      headers: { 'User-Agent': request.headers.get('User-Agent') || '' },
    });
    const newHeaders = new Headers(response.headers);
    newHeaders.set('x-flowboard-spa-proxy', 'static');
    return new Response(response.body, { status: response.status, headers: newHeaders });
  }

  // SPA shell — always serve index.html from Pages
  const targetHtmlUrl = new URL('/index.html', PAGES_ORIGIN);
  const response = await fetch(targetHtmlUrl.toString(), {
    headers: { 'User-Agent': request.headers.get('User-Agent') || '' },
    cf: { cacheEverything: false },
  });
  const newHeaders = new Headers(response.headers);
  newHeaders.set('cache-control', 'no-store');
  newHeaders.set('x-flowboard-spa-proxy', 'spa');
  return new Response(response.body, { status: response.status, headers: newHeaders });
}
