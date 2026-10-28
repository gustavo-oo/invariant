// invariant — best-effort network block for a sabotaged run.
//
// This module is loaded with `node --import` in the child process. It allows
// loopback (the app under test may need a local server) and refuses every other
// destination. It is deliberately small and dependency-free: Node cannot promise
// OS-level network isolation, so this is a guard rail, not a sandbox claim.

import net from "node:net";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import tls from "node:tls";
import dns from "node:dns";

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;
const BLOCKED = "invariant: network is disabled during a sabotaged run";

function deny() {
  throw new Error(BLOCKED);
}

function hostOf(args) {
  const first = args[0];
  if (typeof first === "number") return typeof args[1] === "string" ? hostOnly(args[1]) : "localhost";
  if (typeof first === "string") {
    if (first.startsWith("/") || first.startsWith("\\\\")) return "localhost"; // unix socket
    try {
      return new URL(first).hostname;
    } catch {
      return hostOnly(first);
    }
  }
  if (first !== null && typeof first === "object") {
    if (first.path !== undefined && first.hostname === undefined && first.host === undefined) return "localhost";
    if (typeof first.hostname === "string") return hostOnly(first.hostname);
    if (typeof first.host === "string") return hostOnly(first.host);
    if (typeof first.href === "string") {
      try {
        return new URL(first.href).hostname;
      } catch {
        return undefined;
      }
    }
  }
  if (typeof args[1] === "string") return hostOnly(args[1]);
  return undefined;
}

/** `localhost:80` → `localhost`; `[::1]:80` → `[::1]`. */
function hostOnly(value) {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

function allowed(host) {
  return host === undefined || LOOPBACK.test(host);
}

function wrap(original, label) {
  return function guarded(...args) {
    if (!allowed(hostOf(args))) deny();
    return original.apply(this, args);
  };
}

// node:net
net.connect = wrap(net.connect, "net.connect");
net.createConnection = wrap(net.createConnection, "net.createConnection");

// node:http / node:https
http.request = wrap(http.request, "http.request");
http.get = wrap(http.get, "http.get");
https.request = wrap(https.request, "https.request");
https.get = wrap(https.get, "https.get");

// node:http2 / node:tls
http2.connect = wrap(http2.connect, "http2.connect");
tls.connect = wrap(tls.connect, "tls.connect");

// node:dns — a hostname lookup is the first step of every outbound connection.
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveTxt"]) {
  if (typeof dns[name] === "function") dns[name] = wrap(dns[name], `dns.${name}`);
}

// global fetch (undici). It throws synchronously so a test cannot accidentally
// turn a blocked request into an unhandled rejection.
const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    let host;
    try {
      host = url === undefined ? undefined : new URL(url).hostname;
    } catch {
      host = undefined;
    }
    if (!allowed(host)) deny();
    return originalFetch.call(this, input, init);
  };
}
