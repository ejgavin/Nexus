/*
 * jsDelivr serves .html files as text/plain. This executable entrypoint
 * converts the copied embed.html source into the iframe's actual document.
 * The document URL remains embed.js, so query parameters, hashes, relative
 * assets, and the service-worker scope all stay inside this CDN folder.
 */
(() => {
  const sourceUrl = new URL('./embed.html', location.href);
  fetch(sourceUrl.href, { cache: 'no-store' })
    .then(response => {
      if (!response.ok) throw new Error(`embed.html returned HTTP ${response.status}`);
      return response.text();
    })
    .then(markup => {
      document.open();
      document.write(markup);
      document.close();
    })
    .catch(error => {
      document.open();
      document.write(`<!doctype html><title>Nexus load error</title><body style="margin:0;background:#020810;color:#fca5a5;font:14px system-ui;padding:24px">Nexus embed bootstrap failed: ${String(error.message || error).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]))}</body>`);
      document.close();
    });
})();
