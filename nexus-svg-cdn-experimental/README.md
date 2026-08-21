# Nexus SVG/CDN experimental build

This is a separate experiment based on the SVG entry-point pattern from the supplied project. `index.svg` is the visible shell; it loads its stylesheet and runtime from jsDelivr, then opens the normal Nexus `embed.html` engine in the shell's browsing area.

The SVG shell does not replace the service-worker engine. The browsing engine still needs to be served from one web origin because service workers and SharedWorkers cannot be registered as arbitrary cross-origin assets.

## Test locally

Serve the parent `nexus` folder over HTTP, then open:

```text
http://localhost:8000/nexus-svg-cdn-experimental/index.svg?app=http://localhost:8000
```

For local runtime assets instead of jsDelivr, add:

```text
&cdn=http://localhost:8000/nexus-svg-cdn-experimental&runtime=http://localhost:8000
```

For a deployed copy, the default CDN URL is:

```text
https://cdn.jsdelivr.net/gh/ejgavin/Nexus@main/nexus-svg-cdn-experimental/index.svg?app=https://YOUR-NEXUS-HOST.example
```

Replace `app=` with the deployed origin that serves the regular Nexus files. `backend=` can override the configured HTTP bridge backend, and `cdn=` can point to a fork or pinned jsDelivr version.

This experiment intentionally keeps all target-site traffic inside the regular Nexus engine. The SVG shell itself does not directly fetch target URLs.
