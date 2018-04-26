const nodeFetch = require('node-fetch'),
  h = require('highland'),
  urlUtil = require('url'),
  { getComponentInstance, replaceVersion, getComponentVersion } = require('clayutils'),
  CLAY_ACCESS_KEY = process.env.CLAY_ACCESS_KEY_PROD,
  // AMPHORA_IP = '127.0.0.1';
  AMPHORA_IP = '172.24.16.82'; // clay00

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function streamFetch(url, options) {
  const { hostname } = urlUtil.parse(url);

  url = url.replace(hostname, AMPHORA_IP);
  options = options || {};
  options.headers = options.headers || {};
  options.headers['x-forwarded-host'] = hostname;

  return h(nodeFetch(url, options))
    .flatMap(res => {
      if (res.ok) {
        return h.of(res);
      }
      return h(res.text())
        .map(text => {
          // console.log('(rest error)', JSON.stringify(arguments), res.status, text);
          const err = new Error(`request to ${arguments[0]} failed; ${res.status}: ${text}`);
          err.url = arguments[0];
          err.status = res.status;
          throw err;
        })      
    });
}

function streamFetchJson() {
  return streamFetch.apply(this, arguments)
    .flatMap(res => h(res.json()));
}

function streamClayAssets(endpoint) {
  const { protocol } = urlUtil.parse(endpoint);

  return streamFetchJson(endpoint)
    .sequence()
    .flatMap(uri => h([uri, replaceVersion(uri, 'published')]))
    .map(uri => {
      const url = `${protocol}//${uri}`;
    
      return streamFetchJson(url)
        .map(data => ({url, uri, data}))
        .errors((err, push) => {
          // swallow 404s on published pages
          if (err.status !== 404) throw err;
        })
    })
    .parallel(10);
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
      return h(res.text())
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
 * @param {string} replacements Mapping start layout to end layout
 * (do not use versions)
 * @return {Stream}
 */
function replaceLayoutInSite(site, replacements) {
  return streamClayAssets(`${site}/_pages`)
    .filter(asset => asset.data.layout)
    .filter(asset => replacements[replaceVersion(asset.data.layout)])
    .tap(asset => {
      const layout = asset.data.layout,
        baseLayout = replaceVersion(layout),
        version = getComponentVersion(layout),
        replacement = replacements[baseLayout];

      if (replacement) {
        asset.data.layout = replaceVersion(replacement, version);
      }
    })
    // .tap(i => console.log(JSON.stringify(i)));
    .map(commitAsset)
    .parallel(10);
}

/**
 * Lists all page assets from a site that have the specified layout.
 * @param {string} site e.g.'www.thecut.com/_layout/instances/foo'
 * @param {string} layout e.g. 'www.thecut.com/_layout/instances/foo'
 */
function report(site, layout) {
  const publishedLayout = replaceVersion(layout, 'published');

  assertUri(layout);
  return streamClayAssets(`${site}/_pages`)
    .filter(asset => {
      return asset.data.layout === layout ||
        asset.data.layout === publishedLayout;
    })
    .tap(asset => console.log(JSON.stringify(asset.url)));
}

function assertUri(uri) {
  if (uri.startsWith('http') || !uri.match(/_pages|_components/)) {
    throw new Error('Expected URI but got: ' + uri);
  }
}

function logResult(result) {
  if (result.error) {
    result.error = result.error.stack;
  }
  console.log(JSON.stringify(result));
}

/** Example
replaceLayoutInSite(
  'http://www.thecut.com',
  {
    "www.thecut.com/_components/layout/instances/article-talk": "www.thecut.com/_components/layout/instances/article",
    "www.thecut.com/_components/layout/instances/feature-article-talk": "www.thecut.com/_components/layout/instances/feature-article",
    "www.thecut.com/_components/one-column-layout/instances/article-talk": "www.thecut.com/_components/one-column-layout/instances/article",
    "www.thecut.com/_components/one-column-layout/instances/feature-article-talk": "www.thecut.com/_components/one-column-layout/instances/feature-article",
    "www.thecut.com/_components/one-column-layout/instances/feature-cover-story-talk": "www.thecut.com/_components/one-column-layout/instances/feature-cover-story",
    "www.thecut.com/_components/one-column-layout/instances/feature-horizontal-talk": "www.thecut.com/_components/one-column-layout/instances/feature-horizontal",
    "www.thecut.com/_components/one-column-layout/instances/interactive-article-talk": "www.thecut.com/_components/one-column-layout/instances/interactive-article"

  }
).tap(logResult).done(process.exit);
**/
