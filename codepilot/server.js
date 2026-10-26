/* CodePilot 本地开发服务器
 * 用法: node server.js [端口]
 * 默认端口 8000，然后浏览器访问 http://localhost:8000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '8000', 10);
const ROOT = path.resolve(__dirname);
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.py': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

/* 安全的路径解析：解码失败返回 null，越界返回 null */
function resolvePath(rawUrl) {
    let urlPath;
    try {
        // 只取 path 部分，且 decodeURIComponent 遇到畸形转义会抛异常
        urlPath = decodeURIComponent(String(rawUrl || '/').split('?')[0].split('#')[0]);
    } catch {
        return null; // 畸形 URL（如 /%E0%A4%A）直接当作 400，而不是让进程崩溃
    }
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    // 去掉开头的 /，并用 path.resolve 归一化，防止 ../ 穿越
    const filePath = path.resolve(ROOT, '.' + path.posix.normalize('/' + urlPath));
    // 必须严格位于 ROOT 之内（比较时补上分隔符，避免 /root2 被误判为 /root 的子路径）
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return null;
    return filePath;
}

const server = http.createServer((req, res) => {
    const filePath = resolvePath(req.url);
    if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('400 Bad Request');
        return;
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            // 开发服务器禁用缓存，避免改了 JS 还要手动清缓存
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
});

server.on('clientError', (err, socket) => {
    // 请求本身畸形时只关闭该连接，不要让进程崩溃
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
});

server.listen(PORT, () => {
    console.log('CodePilot 服务器已启动:');
    console.log('  本地访问:  http://localhost:' + PORT);
    console.log('  按 Ctrl+C 停止');
});
