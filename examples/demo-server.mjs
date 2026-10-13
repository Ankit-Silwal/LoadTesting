import http from 'node:http';
const port = Number(process.env.PORT ?? 4000);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/slow') await new Promise(r => setTimeout(r,100));
  const chunks=[]; for await(const chunk of req) chunks.push(chunk);
  const status=url.pathname==='/fail'?503:200;
  res.writeHead(status,{'content-type':'application/json'});
  res.end(JSON.stringify({ok:status===200,method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body:Buffer.concat(chunks).toString()}));
});
server.listen(port,'127.0.0.1',()=>console.log(`Local demo API: http://127.0.0.1:${port}\n/health · /slow · /echo · /fail\nCtrl+C to stop.`));
