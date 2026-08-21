# Nexus SVG/CDN experimental build

This is a separate experiment based on the SVG entry-point pattern from the supplied project. `index.svg` is the visible shell; the folder also contains the Nexus page, service worker, Scramjet assets, BareMux transports, and HTTP bridge modules so the complete build can run below one CDN subdirectory.

The SVG shell and the browsing engine must be served from the same CDN package path. The copied service worker uses that directory as its scope and all Scramjet/transport paths are resolved relative to it.

## Test locally

Serve the parent `nexus` folder over HTTP, then open:

```text
http://localhost:8000/nexus-svg-cdn-experimental/index.svg
```

For a deployed copy on the same static host, the equivalent URL is:

```text
https://YOUR-STATIC-HOST.example/nexus-svg-cdn-experimental/index.svg
```

For the current Netlify deployment, use:

```text
https://sparkly-bunny-a6142a.netlify.app/nexus-svg-cdn-experimental/index.svg
```

If the SVG is served from jsDelivr, use the package directory as the app base:

```text
https://cdn.jsdelivr.net/gh/ejgavin/Nexus@main/nexus-svg-cdn-experimental/index.svg
```

`backend=` can override the HTTP bridge backend. `cdn=` and `runtime=` can point to a fork or pinned static copy, but normally the SVG derives all runtime paths from its own directory.

This experiment keeps target-site traffic inside the copied Nexus engine. The SVG shell itself does not directly fetch target URLs.
