import net from "node:net";

// Bind to port 0 so the OS picks a free port, read it back, then release it.
// We pass the number to createApp(port) immediately after, so the brief gap
// between close and re-bind is acceptable for a single-user local app.
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
