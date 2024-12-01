export function parseMessageURL(url: string): { channel: string, ts: string, threadTs: string|null } {
  const u = new URL(url);
  const m = u.pathname.match(/^\/archives\/([^/]+)\/p(\d+)$/);
  if (!m) {
    throw new Error("Invalid message_url format");
  }
  const channel = m[1];
  const ts = m[2].slice(0, -6) + "." + m[2].slice(-6);
  const threadTs = u.searchParams.get("thread_ts");
  return { channel, ts, threadTs };
}
