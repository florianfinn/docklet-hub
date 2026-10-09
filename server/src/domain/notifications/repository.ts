import type { Pool } from "pg";
import type { NotificationDatabase } from "./types.js";

export function createNotificationDatabase(pool: Pool): NotificationDatabase {
  return {
    query: (sql, values) => pool.query(sql, values),
    transaction: async (operation) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
