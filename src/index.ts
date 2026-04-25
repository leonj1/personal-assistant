import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

const server = createServer((request, response) => {
  const method = request.method ?? "GET";
  const url = request.url ?? "/";

  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (method === "GET" && url === "/health") {
    response.writeHead(200);
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
