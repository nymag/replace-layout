const nodeFetch = require('node-fetch'),
  h = require('highland'),
  urlUtil = require('url'),
  { getComponentInstance, replaceVersion } = require('clayutils'),
  CLAY_ACCESS_KEY = process.env.CLAY_ACCESS_KEY_LOCAL,
  AMPHORA_IP = '127.0.0.1';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function streamFetch(url, options) {
  const { hostname } = urlUtil.parse(url);

  url = url.replace(hostname, AMPHORA_IP);
  options = options || {};
  options.headers = options.headers || {};
  options.headers['x-forwarded-host'] = hostname;

  return h(nodeFetch(url, options));
}

function streamFetchJson() {
  return streamFetch.apply(this, arguments)
    .flatMap(res => {
      if (res.ok) {
        return h(res.json());
      }
      return h(res.text())
        .map(text => {
          const err = new Error(`request failed ${JSON.stringify(arguments)}; ${res.status}: ${text}`);
          
          err.status = res.status;
          throw err;
        })
    });
}

function streamClayAssets(endpoint) {
  const { protocol } = urlUtil.parse(endpoint);

  return streamFetchJson(endpoint)
    .sequence()
    .flatMap(uri => h([uri, replaceVersion(uri, 'published')]))
    .flatMap(uri => {
      const url = `${protocol}//${uri}`;
    
      return streamFetchJson(url)
        .map(data => ({url, uri, data}))
        .errors((err, push) => {
          if (err.status !== 404) throw err;
        })
    });
}

function replaceLayout(asset, fromLayout, toLayout) {
  if (asset.data.layout) {
    if (asset.data.layout === fromLayout) {
      asset.data.layout = toLayout;
    }
  }
}

function commitAsset(asset) {
  return streamFetch(asset.url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'authorization': `token ${CLAY_ACCESS_KEY}`
    },
    body: JSON.stringify(asset.data)
  })
  .flatMap(res => {
    if (res.ok) {
      return h.of(({status: 'success', url: asset.url}));
    } else {
      return res.text()
        .map(text => ({
          status: 'error',
          url: asset.url,
          error: `${res.status}: ${text}`
        }));
    }
  })
}

/**
 * Replaces all refs to a given layout to another layout in all pages of a
 * given site.
 * @param {string} site e.g. 'https://www.thecut.com'
 * @param {string} fromLayout e.g. 'www.thecut.com/_layout/instances/foo'
 * @param {string} toLayout 'www.thecut.com/_layout/instances/bar'
 * @return {Stream}
 */
function replaceLayoutInSite(site, fromLayout, toLayout) {
  const fromPublished = replaceVersion(fromLayout, 'published'),
    toPublished = replaceVersion(toLayout, 'published');

  return streamClayAssets(`${site}/_pages`)
    // .tap(asset => console.log('checking', asset.uri))
    .filter(asset => asset.data.layout === fromLayout ||
      asset.data.layout === fromPublished
    )
    .tap(asset => replaceLayout(asset, fromLayout, toLayout))
    .tap(asset => replaceLayout(asset, fromPublished, toPublished))
    .flatMap(commitAsset);
}

/**
 * Lists all page assets from a site that have the specified layout.
 * @param {string} site e.g.'www.thecut.com/_layout/instances/foo'
 * @param {string} layout e.g. 'www.thecut.com/_layout/instances/foo'
 */
function report(site, layout) {
  const publishedLayout = replaceVersion(layout, 'published');

  return streamClayAssets(`${site}/_pages`)
    .filter(asset => asset.data.layout === layout ||
      asset.data.layout === publishedLayout
    )
    .tap(asset => console.log(JSON.stringify(asset.url)));
}

function logResult(i) {
  console.log(JSON.stringify(i));
}

replaceLayoutInSite(
  'https://localhost.thecut.com',
  'localhost.thecut.com/_components/layout/instances/article2',
  'localhost.thecut.com/_components/layout/instances/article'
).tap(logResult).done(process.exit);
