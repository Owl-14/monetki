const http = require('http');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
http.createServer((request, response) => {
  const pathname = decodeURIComponent(request.url.split('?')[0] === '/' ? '/index.html' : request.url.split('?')[0]);
  fs.readFile(path.join(root, pathname), (error, data) => {
    if (error) { response.writeHead(404); response.end('not found'); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(pathname)] || 'application/octet-stream' });
    response.end(data);
  });
}).listen(8765, '127.0.0.1');
