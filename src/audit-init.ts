/** One-off: create the HCS audit topic. Usage: npm run audit:init */
import "dotenv/config";
import { createAuditTopic } from "./audit.js";

const topicId = await createAuditTopic();
console.log(`\nAudit topic created: ${topicId}`);
console.log("Add this to your .env as HCS_TOPIC_ID and restart the server.\n");
