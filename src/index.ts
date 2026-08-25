import "dotenv/config";
import { config } from "./config.js";
import { buildServer } from "./server.js";

const app = await buildServer();

await app.listen({ port: config.port, host: config.host });
