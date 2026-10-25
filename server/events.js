// Server-Sent Events: pushes payment status to the POS screen in real time.

const listeners = new Map();   // sessionId -> Set of open responses

export function subscribe(sessionId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
  listeners.get(sessionId).add(res);

  // Keep proxies/tunnels from closing an idle connection.
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);

  res.on('close', () => {
    clearInterval(ping);
    listeners.get(sessionId)?.delete(res);
    if (listeners.get(sessionId)?.size === 0) listeners.delete(sessionId);
  });
}

export function publish(sessionId, data) {
  for (const res of listeners.get(sessionId) || []) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
