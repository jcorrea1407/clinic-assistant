import upland from "./upland/config.js";

// Every configured client. Add a client by creating clients/<id>/config.ts
// and listing it here. Each entry is validated at build and on first request.
export const clientRegistry: readonly unknown[] = [upland];
