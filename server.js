const http=require("http"),fs=require("fs"),path=require("path");
const port=process.env.PORT||8765;
http.createServer((req,res)=>{
  const f=path.join(__dirname,"public",req.url==="/"? "index.html":req.url.replace(/^\//,""));
  fs.readFile(f,(e,d)=>{ if(e){res.writeHead(404);res.end("not found");return;} res.writeHead(200);res.end(d);});
}).listen(port,"127.0.0.1",()=>console.log("Darul Sakina http://127.0.0.1:"+port));
