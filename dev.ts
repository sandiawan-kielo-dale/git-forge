// dev.ts — local development server: binds a fixed port (default 8080) so the
// kit's local runner can dial it. Not part of the graded entry (main.ts is).
// Usage: MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8080);
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  console.log(`[dev] git-forge listening on http://127.0.0.1:${port}`);
});
