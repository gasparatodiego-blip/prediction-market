const http = require('http');
const fs = require('fs');
const port = 3000;
http.createServer((req, res) => {
    let file = req.url === '/' ? '/index.html' : req.url;
    fs.readFile('./public' + file, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('404');
        } else {
            res.writeHead(200);
            res.end(data);
        }
    });
}).listen(port, '0.0.0.0', () => {
    console.log('Server su http://0.0.0.0:' + port);
});
