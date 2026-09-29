import { randomUUID } from "node:crypto";
import { migrate, pool, passwordHash } from "./db";
import { userInputSchema } from "../shared/collab";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = userInputSchema.parse(JSON.parse(raw));
await migrate();
await pool.query(
  "INSERT INTO users(id,username,display_name,password,admin) VALUES($1,$2,$3,$4,true)",
  [
    randomUUID(),
    input.username,
    input.displayName,
    passwordHash(input.password),
  ],
);
await pool.end();
console.log("Administrator created; initial password change required.");
