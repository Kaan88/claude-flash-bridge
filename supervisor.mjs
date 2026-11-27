// Entry of the independent supervisor: node supervisor.mjs LAUNCH [PORT TOKEN].
// On Windows it starts with the system variables only and takes the launching bridge's
// environment from that bridge itself, before anything reads a setting from it.
import { takeEnvironment } from "./process-identity.mjs";

const [launch, port, token] = process.argv.slice(2);
if (port) await takeEnvironment(port, token);
const { supervise } = await import("./job-service.mjs");
await supervise(launch);
