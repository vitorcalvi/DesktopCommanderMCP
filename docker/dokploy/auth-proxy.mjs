#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';

const LISTEN_HOST = process.env.AUTH_PROXY_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.AUTH_PROXY_PORT || '8766');
const UPSTREAM = new URL(process.env.MCP_UPSTREAM_URL || 'http://127.0.0.1:8765');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://agent-dispatch.dyagnosys.com/desktop-commander').replace(/\/$/, '');
const RESOURCE_PATH = process.env.MCP_PUBLIC_PATH || '/desktop-commander/mcp';
const CF_ACCESS_ENABLED = /^(1|true|yes)$/i.test(process.env.CF_ACCESS_ENABLED || '1');
const CF_ACCESS_TEAM_DOMAIN = (process.env.CF_ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD || '';
const CF_ACCESS_ALLOWED_EMAILS = new Set(
  (process.env.CF_ACCESS_ALLOWED_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const OPERATOR_TOKEN = process.env.DESKTOP_COMMANDER_OPERATOR_TOKEN || '';

const jwksCache = { expiresAt: 0, keys: [] };

function json(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function audit(event, meta = {}) {
  const safe = Object.fromEntries(
    Object.entries(meta).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)),
  );
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...safe })}\n`);
}

function base64urlDecode(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const header = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
  const claims = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: base64urlDecode(parts[2]) };
}

async function getJwks(force = false) {
  if (!CF_ACCESS_TEAM_DOMAIN) throw new Error('CF_ACCESS_TEAM_DOMAIN is required');
  const now = Date.now();
  if (!force && jwksCache.keys.length && now < jwksCache.expiresAt) return jwksCache.keys;
  const response = await fetch(`https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Cloudflare JWKS HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) throw new Error('Cloudflare JWKS is empty');
  jwksCache.keys = payload.keys;
  jwksCache.expiresAt = now + 5 * 60 * 1000;
  return jwksCache.keys;
}

function audienceMatches(aud) {
  if (!CF_ACCESS_AUD) return false;
  return Array.isArray(aud) ? aud.includes(CF_ACCESS_AUD) : aud === CF_ACCESS_AUD;
}

async function validateCloudflareJwt(token) {
  const parsed = parseJwt(token);
  if (parsed.header.alg !== 'RS256' || !parsed.header.kid) throw new Error('unsupported JWT header');
  let keys = await getJwks();
  let jwk = keys.find((key) => key.kid === parsed.header.kid);
  if (!jwk) {
    keys = await getJwks(true);
    jwk = keys.find((key) => key.kid === parsed.header.kid);
  }
  if (!jwk) throw new Error('signing key not found');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify('RSA-SHA256', Buffer.from(parsed.signingInput), publicKey, parsed.signature);
  if (!valid) throw new Error('invalid JWT signature');

  const now = Math.floor(Date.now() / 1000);
  const issuer = `https://${CF_ACCESS_TEAM_DOMAIN}`;
  if (parsed.claims.iss !== issuer) throw new Error('issuer mismatch');
  if (!audienceMatches(parsed.claims.aud)) throw new Error('audience mismatch');
  if (!Number.isFinite(parsed.claims.exp) || parsed.claims.exp <= now - 30) throw new Error('token expired');
  if (Number.isFinite(parsed.claims.nbf) && parsed.claims.nbf > now + 30) throw new Error('token not active');
  if (Number.isFinite(parsed.claims.iat) && parsed.claims.iat > now + 30) throw new Error('token issued in future');

  const email = String(parsed.claims.email || '').toLowerCase();
  if (CF_ACCESS_ALLOWED_EMAILS.size && !CF_ACCESS_ALLOWED_EMAILS.has(email)) {
    throw new Error('identity not allowed');
  }
  return { email, sub: String(parsed.claims.sub || ''), claims: parsed.claims };
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

function operatorTokenMatches(candidate) {
  if (!OPERATOR_TOKEN || !candidate) return false;
  const expected = Buffer.from(OPERATOR_TOKEN);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function unauthorized(res, description = 'Missing or invalid access token') {
  const resourceMetadata = `https://agent-dispatch.dyagnosys.com/.well-known/cloudflare-access-protected-resource${RESOURCE_PATH}`;
  json(
    res,
    401,
    { error: 'invalid_token', error_description: description, resource_metadata: resourceMetadata },
    { 'www-authenticate': `Bearer realm="OAuth", error="invalid_token", resource_metadata="${resourceMetadata}"` },
  );
}

async function authenticate(req) {
  const directBearer = bearerToken(req);
  if (operatorTokenMatches(directBearer)) {
    return { principal: 'operator-token', method: 'static' };
  }

  if (!CF_ACCESS_ENABLED) throw new Error('Cloudflare Access validation disabled and no valid operator token supplied');
  const assertion = String(req.headers['cf-access-jwt-assertion'] || '');
  if (!assertion) throw new Error('Cloudflare Access assertion missing');
  const identity = await validateCloudflareJwt(assertion);
  return { principal: identity.email || identity.sub || 'cloudflare-user', method: 'cloudflare-access' };
}

function upstreamPath(originalUrl) {
  const parsed = new URL(originalUrl || '/', 'http://localhost');
  let path = parsed.pathname;
  if (path === RESOURCE_PATH || path.startsWith(`${RESOURCE_PATH}/`)) {
    path = `/mcp${path.slice(RESOURCE_PATH.length)}`;
  }
  return `${path}${parsed.search}`;
}

function proxy(req, res, identity) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['cf-access-jwt-assertion'];
  delete headers.cookie;
  if (identity) headers['x-desktop-commander-principal'] = identity.principal;

  const options = {
    protocol: UPSTREAM.protocol,
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port,
    method: req.method,
    path: upstreamPath(req.url),
    headers,
  };

  const upstreamReq = http.request(options, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    delete responseHeaders['set-cookie'];
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    audit('proxy_error', { message: error.message });
    if (!res.headersSent) json(res, 502, { error: 'bad_gateway' });
    else res.destroy(error);
  });
  req.pipe(upstreamReq);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

  if (pathname === '/healthz' || pathname === '/desktop-commander/healthz') {
    try {
      const response = await fetch(`${UPSTREAM.origin}/mcp`, {
        method: 'GET',
        headers: { accept: 'application/json, text/event-stream' },
        signal: AbortSignal.timeout(1500),
      });
      json(res, 200, { status: 'ok', upstream_status: response.status });
    } catch (error) {
      json(res, 503, { status: 'degraded', error: String(error.message || error) });
    }
    return;
  }

  if (!(pathname === RESOURCE_PATH || pathname.startsWith(`${RESOURCE_PATH}/`))) {
    json(res, 404, { error: 'not_found' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,accept,mcp-session-id,mcp-protocol-version,last-event-id,mcp-method,mcp-name',
      'access-control-expose-headers': 'mcp-session-id',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  let identity;
  try {
    identity = await authenticate(req);
  } catch (error) {
    audit('auth_rejected', { reason: String(error.message || error) });
    unauthorized(res);
    return;
  }

  audit('auth_accepted', { principal: identity.principal, method: identity.method, request_method: req.method, path: pathname });
  proxy(req, res, identity);
});

server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 0;
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  audit('proxy_started', { host: LISTEN_HOST, port: LISTEN_PORT, upstream: UPSTREAM.origin, resource_path: RESOURCE_PATH });
});
