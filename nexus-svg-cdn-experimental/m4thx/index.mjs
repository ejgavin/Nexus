const e = 20,
  t = globalThis.fetch,
  r = globalThis.SharedWorker,
  a = globalThis.localStorage,
  s = globalThis.navigator.serviceWorker,
  o = MessagePort.prototype.postMessage,
  n = {
    prototype: { send: WebSocket.prototype.send },
    CLOSED: WebSocket.CLOSED,
    CLOSING: WebSocket.CLOSING,
    CONNECTING: WebSocket.CONNECTING,
    OPEN: WebSocket.OPEN
  };
let muxSocketSequence = 0;

function muxUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (_) {
    return String(value || '').slice(0, 240);
  }
}

function muxLog(message, details) {
  console.log('%c[Nexus:mux]', 'color:#facc15;font-weight:700', new Date().toISOString(), message, details || '');
}

function muxWarn(message, details) {
  console.warn('%c[Nexus:mux]', 'color:#f97316;font-weight:700', new Date().toISOString(), message, details || '');
}
async function c() {
  const e = (await self.clients.matchAll({ type: 'window', includeUncontrolled: !0 })).map(async (e) => {
      const t = await (function (e) {
        let t = new MessageChannel();
        return new Promise((r) => {
          (e.postMessage({ type: 'getPort', port: t.port2 }, [t.port2]),
            (t.port1.onmessage = (e) => {
              r(e.data);
            }));
        });
      })(e);
      return (await i(t), t);
    }),
    t = Promise.race([Promise.any(e), new Promise((e, t) => setTimeout(t, 1e3, new TypeError('timeout')))]);
  try {
    return await t;
  } catch (e) {
    if (e instanceof AggregateError)
      throw (
        console.error('bare-mux: failed to get a bare-mux SharedWorker MessagePort as all clients returned an invalid MessagePort.'),
        new Error('All clients returned an invalid MessagePort.')
      );
    // This is normally a short startup race. Keep it out of the default
    // warning channel because recursive retries otherwise flood the console.
    console.debug('[Nexus:mux] SharedWorker port not ready after 1s; retrying');
    return await c();
  }
}
function i(e) {
  const t = new MessageChannel(),
    r = new Promise((e, r) => {
      ((t.port1.onmessage = (t) => {
        'pong' === t.data.type && e();
      }),
        setTimeout(r, 1500));
    });
  return (o.call(e, { message: { type: 'ping' }, port: t.port2 }, [t.port2]), r);
}
function l(e, t) {
  const a = new r(e, 'bare-mux-worker');
  return (
    t &&
      s.addEventListener('message', async (t) => {
        if ('getPort' === t.data.type && t.data.port) {
          console.log('%c[Nexus:mux]', 'color:#34d399;font-weight:700', 'service worker requested a SharedWorker port');
          // Return the port immediately. Waiting for the page-side
          // transport promise here can deadlock: the transport setup and
          // the service-worker request both use this SharedWorker. The
          // worker can safely queue its first message until the transport
          // is selected, while refusing the port makes every retry loop
          // forever and prevents the SW config acknowledgment from ever
          // arriving.
          if (globalThis.__nexusMuxTransportReady) {
            console.debug('%c[Nexus:mux]', 'color:#facc15;font-weight:700', 'returning SharedWorker port without waiting for transport setup');
          }
          const a = new r(e, 'bare-mux-worker');
          o.call(t.data.port, a.port, [a.port]);
        }
      }),
    a.port
  );
}
let h = null;
function d() {
  if (null === h) {
    const e = new MessageChannel(),
      t = new ReadableStream();
    let r;
    try {
      (o.call(e.port1, t, [t]), (r = !0));
    } catch (e) {
      r = !1;
    }
    return ((h = r), r);
  }
  return h;
}
class p {
  constructor(e) {
    ((this.channel = new BroadcastChannel('bare-mux')),
      e instanceof MessagePort || e instanceof Promise ? (this.port = e) : this.createChannel(e, !0));
  }
  createChannel(e, t) {
    if (self.clients)
      ((this.port = c()),
        (this.channel.onmessage = (e) => {
          'refreshPort' === e.data.type && (this.port = c());
        }));
    else if (e && SharedWorker) {
      if (!e.startsWith('/') && !e.includes('://')) throw new Error('Invalid URL. Must be absolute or start at the root.');
      ((this.port = l(e, t)), console.debug('bare-mux: setting localStorage bare-mux-path to', e), (a['bare-mux-path'] = e));
    } else {
      if (!SharedWorker) throw new Error('Unable to get a channel to the SharedWorker.');
      {
        const e = a['bare-mux-path'];
        if ((console.debug('bare-mux: got localStorage bare-mux-path:', e), !e))
          throw new Error('Unable to get bare-mux workerPath from localStorage.');
        this.port = l(e, t);
      }
    }
  }
  async sendMessage(e, t) {
    this.port instanceof Promise && (this.port = await this.port);
    try {
      await i(this.port);
    } catch {
      return (
        console.debug('[Nexus:mux] worker ping timed out; recreating the port'),
        this.createChannel(),
        await this.sendMessage(e, t)
      );
    }
    const r = new MessageChannel(),
      a = [r.port2, ...(t || [])],
      s = new Promise((e, t) => {
        r.port1.onmessage = (r) => {
          const a = r.data;
          'error' === a.type ? t(a.error) : e(a);
        };
      });
    return (o.call(this.port, { message: e, port: r.port2 }, a), await s);
  }
}
class w extends EventTarget {
  constructor(e, t = [], r, a) {
    (super(), (this.protocols = t), (this.readyState = n.CONNECTING), (this.url = e.toString()), (this.protocols = t), (this.__nexusSocketId = `site-ws-${++muxSocketSequence}`));
    muxLog('websocket.site.constructed', { socketId: this.__nexusSocketId, url: muxUrl(this.url), protocols: t, readyState: 'CONNECTING' });
    const s = (e) => {
        ((this.protocols = e), (this.readyState = n.OPEN));
        muxLog('websocket.site.open', { socketId: this.__nexusSocketId, protocol: e || '' });
        const t = new Event('open');
        this.dispatchEvent(t);
      },
      o = async (e) => {
        muxLog('websocket.site.message', { socketId: this.__nexusSocketId, bytes: e?.byteLength ?? e?.length ?? 0, type: typeof e });
        const t = new MessageEvent('message', { data: e });
        this.dispatchEvent(t);
      },
      c = (e, t) => {
        this.readyState = n.CLOSED;
        muxWarn('websocket.site.close', { socketId: this.__nexusSocketId, code: e, reason: t || '' });
        const r = new CloseEvent('close', { code: e, reason: t });
        this.dispatchEvent(r);
      },
      i = () => {
        this.readyState = n.CLOSED;
        muxWarn('websocket.site.error', { socketId: this.__nexusSocketId });
        const e = new Event('error');
        this.dispatchEvent(e);
      };
    ((this.channel = new MessageChannel()),
      (this.channel.port1.onmessage = (e) => {
        'open' === e.data.type
          ? s(e.data.args[0])
          : 'message' === e.data.type
            ? o(e.data.args[0])
            : 'close' === e.data.type
              ? c(e.data.args[0], e.data.args[1])
              : 'error' === e.data.type && i();
      }),
      muxLog('websocket.site.route.requested', { socketId: this.__nexusSocketId, url: muxUrl(this.url), transport: 'configured remote transport' }),
      r.sendMessage({ type: 'websocket', websocket: { url: e.toString(), protocols: t, requestHeaders: a, channel: this.channel.port2 } }, [
        this.channel.port2
      ]).catch((error) => muxWarn('websocket.site.route.request.failed', { socketId: this.__nexusSocketId, message: error?.message || String(error) })));
  }
  send(...e) {
    if (this.readyState === n.CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
    let t = e[0];
    muxLog('websocket.site.send', { socketId: this.__nexusSocketId, bytes: t?.byteLength ?? t?.length ?? 0, type: typeof t });
    (t.buffer && (t = t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength)),
      o.call(this.channel.port1, { type: 'data', data: t }, t instanceof ArrayBuffer ? [t] : []));
  }
  close(e, t) {
    muxLog('websocket.site.close.requested', { socketId: this.__nexusSocketId, code: e, reason: t || '' });
    o.call(this.channel.port1, { type: 'close', closeCode: e, closeReason: t });
  }
}
function u(e, t, r) {
  (console.error(`error while processing '${r}': `, t), e.postMessage({ type: 'error', error: t }));
}
function g(e) {
  for (let t = 0; t < e.length; t++) {
    const r = e[t];
    if (!"!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~".includes(r)) return !1;
  }
  return !0;
}
const f = ['ws:', 'wss:'],
  y = [101, 204, 205, 304],
  b = [301, 302, 303, 307, 308];
class m {
  constructor(e) {
    this.worker = new p(e);
  }
  async getTransport() {
    return (await this.worker.sendMessage({ type: 'get' })).name;
  }
  async setTransport(e, t, r) {
    await this.setManualTransport(
      `\n\t\t\tconst { default: BareTransport } = await import("${e}");\n\t\t\treturn [BareTransport, "${e}"];\n\t\t`,
      t,
      r
    );
  }
  async setManualTransport(e, t, r) {
    if ('bare-mux-remote' === e) throw new Error('Use setRemoteTransport.');
    await this.worker.sendMessage({ type: 'set', client: { function: e, args: t } }, r);
  }
  async setRemoteTransport(e, t) {
    const r = new MessageChannel();
    ((r.port1.onmessage = async (t) => {
      const r = t.data.port,
        a = t.data.message;
      if ('fetch' === a.type)
        try {
          (e.ready || (await e.init()),
            await (async function (e, t, r) {
              const a = await r.request(new URL(e.fetch.remote), e.fetch.method, e.fetch.body, e.fetch.headers, null);
              if (!d() && a.body instanceof ReadableStream) {
                const e = new Response(a.body);
                a.body = await e.arrayBuffer();
              }
              a.body instanceof ReadableStream || a.body instanceof ArrayBuffer
                ? o.call(t, { type: 'fetch', fetch: a }, [a.body])
                : o.call(t, { type: 'fetch', fetch: a });
            })(a, r, e));
        } catch (e) {
          u(r, e, 'fetch');
        }
      else if ('websocket' === a.type)
        try {
          const socketId = a.websocket.channel ? `remote-ws-${++muxSocketSequence}` : 'remote-ws-unknown';
          muxLog('websocket.remote.request', { socketId, url: muxUrl(a.websocket.url), protocols: a.websocket.protocols || [], transport: e.constructor?.name || 'configured transport' });
          (e.ready || (await e.init()),
            await (async function (e, t, r) {
              const [a, s] = r.connect(
                new URL(e.websocket.url),
                e.websocket.protocols,
                e.websocket.requestHeaders,
                (t) => {
                  muxLog('websocket.remote.open', { socketId, protocol: t || '' });
                  o.call(e.websocket.channel, { type: 'open', args: [t] });
                },
                (t) => {
                  muxLog('websocket.remote.message', { socketId, bytes: t?.byteLength ?? t?.length ?? 0, type: typeof t });
                  t instanceof ArrayBuffer
                    ? o.call(e.websocket.channel, { type: 'message', args: [t] }, [t])
                    : o.call(e.websocket.channel, { type: 'message', args: [t] });
                },
                (t, r) => {
                  muxWarn('websocket.remote.close', { socketId, code: t, reason: r || '' });
                  o.call(e.websocket.channel, { type: 'close', args: [t, r] });
                },
                (t) => {
                  muxWarn('websocket.remote.error', { socketId, message: t?.message || String(t || '') });
                  o.call(e.websocket.channel, { type: 'error', args: [t] });
                }
              );
              ((e.websocket.channel.onmessage = (e) => {
                'data' === e.data.type
                  ? (muxLog('websocket.remote.send', { socketId, bytes: e.data.data?.byteLength ?? e.data.data?.length ?? 0, type: typeof e.data.data }), a(e.data.data))
                  : 'close' === e.data.type && (muxLog('websocket.remote.close.requested', { socketId, code: e.data.closeCode, reason: e.data.closeReason || '' }), s(e.data.closeCode, e.data.closeReason));
              }),
                muxLog('websocket.remote.ready', { socketId }),
                o.call(t, { type: 'websocket' }));
            })(a, r, e));
        } catch (e) {
          u(r, e, 'websocket');
        }
    }),
      await this.worker.sendMessage({ type: 'set', client: { function: 'bare-mux-remote', args: [r.port2, t] } }, [r.port2]));
  }
  getInnerPort() {
    return this.worker.port;
  }
}
class k {
  constructor(e) {
    this.worker = new p(e);
  }
  createWebSocket(e, t = [], r, a) {
    try {
      e = new URL(e);
    } catch (t) {
      throw new DOMException(`Faiiled to construct 'WebSocket': The URL '${e}' is invalid.`);
    }
    if (!f.includes(e.protocol))
      throw new DOMException(`Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${e.protocol}' is not allowed.`);
    (Array.isArray(t) || (t = [t]), (t = t.map(String)));
    for (const e of t) if (!g(e)) throw new DOMException(`Failed to construct 'WebSocket': The subprotocol '${e}' is invalid.`);
    a = a || {};
    return new w(e, t, this.worker, a);
  }
  async fetch(e, r) {
    const a = new Request(e, r),
      s = r?.headers || a.headers,
      o = s instanceof Headers ? Object.fromEntries(s) : s,
      n = a.body;
    let c = new URL(a.url);
    if (c.protocol.startsWith('blob:')) {
      const e = await t(c),
        r = new Response(e.body, e);
      return ((r.rawHeaders = Object.fromEntries(e.headers)), r);
    }
    for (let e = 0; ; e++) {
      let t = (
          await this.worker.sendMessage(
            { type: 'fetch', fetch: { remote: c.toString(), method: a.method, headers: o, body: n || void 0 } },
            n ? [n] : []
          )
        ).fetch,
        s = new Response(y.includes(t.status) ? void 0 : t.body, { headers: new Headers(t.headers), status: t.status, statusText: t.statusText });
      ((s.rawHeaders = t.headers), (s.rawResponse = t), (s.finalURL = c.toString()));
      const i = r?.redirect || a.redirect;
      if (!b.includes(s.status)) return s;
      switch (i) {
        case 'follow': {
          const t = s.headers.get('location');
          if (20 > e && null !== t) {
            c = new URL(t, c);
            continue;
          }
          throw new TypeError('Failed to fetch');
        }
        case 'error':
          throw new TypeError('Failed to fetch');
        case 'manual':
          return s;
      }
    }
  }
}
console.debug('bare-mux: running v2.1.7 (build c56d286)');
export {
  k as BareClient,
  m as BareMuxConnection,
  w as BareWebSocket,
  n as WebSocketFields,
  p as WorkerConnection,
  d as browserSupportsTransferringStreams,
  k as default,
  e as maxRedirects,
  g as validProtocol
};
//# sourceMappingURL=index.mjs.map
