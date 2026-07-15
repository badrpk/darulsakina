const http = require("http");
const fs = require("fs");
const path = require("path");
const port = process.env.PORT || 8765;
http.createServer((req, res) => {
  const file = path.join(__dirname, "public", req.url === "/" ? "index.html" : req.url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200); res.end(data);
  });
}).listen(port, "127.0.0.1", () => console.log("static on", port));
