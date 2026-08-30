# syntax=docker/dockerfile:1.7
FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213 AS build

WORKDIR /repo
RUN npm install --global pnpm@9.15.9
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages packages
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm --filter @glyphquire/web... build

FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213
WORKDIR /app
ENV NODE_ENV=production PORT=4173
COPY --from=build /repo/apps/web/dist ./dist
USER node
EXPOSE 4173
CMD ["node", "-e", "const http=require('http'),fs=require('fs'),path=require('path'),root=path.resolve('/app/dist'),mime={'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};http.createServer((req,res)=>{let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{res.writeHead(400);return res.end()};const candidate=path.resolve(root,'.'+pathname);if(candidate!==root&&!candidate.startsWith(root+path.sep)){res.writeHead(400);return res.end()};let file=candidate;if(pathname==='/'||(!fs.existsSync(file)&&!pathname.startsWith('/assets/')))file=path.join(root,'index.html');if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end()};res.setHeader('content-type',mime[path.extname(file).toLowerCase()]||'application/octet-stream');res.end(fs.readFileSync(file))}).listen(process.env.PORT)"]
