export { createDb, type Database } from "./client.js";
export {
  user,
  session,
  account,
  verification,
  userRelations,
  sessionRelations,
  accountRelations,
} from "./schema/index.js";

export type { InferSelectModel, InferInsertModel } from "drizzle-orm";
