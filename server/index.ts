import { buildServer } from "./app";
import { pool } from "./db";
const server = await buildServer();
await server.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT || 3000),
});
console.log("Moye collaboration service ready");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void server
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
