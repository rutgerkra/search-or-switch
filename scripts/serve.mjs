import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const allowed = new Set(["popup.html", "popup.js", "popup.css", "popup-input.js", "history-search.js", "favicon-cache.js", "shortcut-settings.js", "core.js", "popup-tabs.js", "preview.js", "icons/icon.svg"]);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "popup.html" : pathname.slice(1);
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep) || !allowed.has(relative)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const data = await readFile(file);
    response.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(data);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Preview: http://127.0.0.1:${port}\nExample tabs only. Load manifest.json in Firefox for real tab actions.`));
