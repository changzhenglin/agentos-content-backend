import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "./schema.js";

export function createDb(url: string) {
  return drizzle(new Pool({ connectionString: url }), { schema });
}

export { schema };
