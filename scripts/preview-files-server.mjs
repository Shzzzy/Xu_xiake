import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 59596);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const decoded = decodeURIComponent(url.pathname);
    // 兼容旧的 /files/xxx 预览地址，其余路径按根目录直接解析。
    const requested = decoded.startsWith("/files/") ? decoded.slice("/files".length) : decoded;
    const target = resolve(join(root, normalize(requested)));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const info = await stat(target).catch(() => null);
    const filePath = info?.isDirectory() ? join(target, "index.html") : target;
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": types[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`preview server on http://localhost:${port}/ (root: ${root})`);
});
