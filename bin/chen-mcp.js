#!/usr/bin/env node
import { startServer } from "../dist/mcp/server.js";

startServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
