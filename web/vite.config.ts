import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// VM files (WASM, firmware, kernel, disk blocks) live in ../dist/vm and are
// served at /vm/ without going through Vite's module pipeline.
const VM_DIR = resolve(__dirname, '../dist/vm');

const TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.txt': 'text/plain',
  '.cfg': 'text/plain',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

function serveVm(): Plugin {
  return {
    name: 'xiaonux-serve-vm',
    configureServer(server) {
      server.middlewares.use('/vm', serveVmFiles);
    },
    // `vite preview` (production build, no live-reload client) serves /vm too
    configurePreviewServer(server) {
      server.middlewares.use('/vm', serveVmFiles);
    },
  };
}

function serveVmFiles(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  const file = join(VM_DIR, path);
  if (!file.startsWith(VM_DIR)) return next();
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return next();
    size = st.size;
  } catch {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(file).pipe(res);
}

// Needed later for SharedArrayBuffer; harmless now.
const COI = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [serveVm()],
  server: { port: 5180, headers: COI },
  preview: { port: 5180, headers: COI },
  worker: { format: 'es' },
});
