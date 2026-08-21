/* =========================================================
   Local development server with dependency-free live reload
   ========================================================= */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELOAD_PATH = '/__paperpiano_reload';
const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webm': 'video/webm',
};

function resolveRequestPath (root, requestUrl) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
    } catch (error) {
        return null;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

function injectLiveReload (html) {
    const client = `<script>
        (() => {
            const events = new EventSource('${RELOAD_PATH}');
            events.addEventListener('reload', () => location.reload());
        })();
    </script>`;
    return html.includes('</body>') ? html.replace('</body>', client + '\n</body>') : html + client;
}

function createDevServer (options = {}) {
    const root = path.resolve(options.root || PROJECT_ROOT);
    const reloadClients = new Set();
    let reloadTimer = null;

    const server = http.createServer(async (request, response) => {
        const requestPath = new URL(request.url, 'http://localhost').pathname;
        if (requestPath === RELOAD_PATH) {
            response.writeHead(200, {
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Content-Type': 'text/event-stream',
            });
            response.write('retry: 1000\n\n');
            reloadClients.add(response);
            request.on('close', () => reloadClients.delete(response));
            return;
        }

        const filePath = resolveRequestPath(root, request.url);
        if (!filePath) {
            respond(response, 400, 'Bad request');
            return;
        }

        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) {
                respond(response, 404, 'Not found');
                return;
            }

            let body = await fs.promises.readFile(filePath);
            const extension = path.extname(filePath).toLowerCase();
            if (extension === '.html') body = Buffer.from(injectLiveReload(body.toString('utf8')));

            response.writeHead(200, {
                'Cache-Control': 'no-store',
                'Content-Length': body.length,
                'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff',
            });
            if (request.method === 'HEAD') response.end();
            else response.end(body);
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
                respond(response, 404, 'Not found');
                return;
            }
            console.error('[dev-server] request failed:', error);
            respond(response, 500, 'Internal server error');
        }
    });

    let watcher = null;
    try {
        watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
            if (!filename || shouldIgnore(filename)) return;
            if (reloadTimer) clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => {
                for (const client of reloadClients) client.write('event: reload\ndata: change\n\n');
            }, 80);
        });
    } catch (error) {
        console.warn('[dev-server] live reload is unavailable:', error.message);
    }

    function close () {
        if (reloadTimer) clearTimeout(reloadTimer);
        if (watcher) watcher.close();
        for (const client of reloadClients) client.end();
        reloadClients.clear();
        return new Promise(resolve => server.close(resolve));
    }

    return { close, server };
}

function shouldIgnore (filename) {
    const normalized = String(filename).replaceAll('\\', '/');
    return normalized.startsWith('.git/') || normalized.startsWith('node_modules/') ||
        normalized.includes('/.git/') || normalized.includes('/node_modules/');
}

function respond (response, status, message) {
    const body = Buffer.from(message + '\n');
    response.writeHead(status, {
        'Content-Length': body.length,
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
}

if (require.main === module) {
    const port = Number.parseInt(process.env.PORT || '8000', 10);
    const host = '127.0.0.1';
    const app = createDevServer();
    app.server.listen(port, host, () => {
        console.log(`Paper Piano ready at http://${host}:${port}`);
        console.log('Watching source files for live reload.');
    });

    const shutdown = () => app.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

module.exports = {
    RELOAD_PATH,
    createDevServer,
    injectLiveReload,
    resolveRequestPath,
    shouldIgnore,
};
