import { getClients } from "../src/config/load.js";

// GET /api/health: proves every client config and fact sheet loads, and says
// which model each client uses. It never calls the model.

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405, headers: { allow: "GET" } });
    }

    try {
      const clients = await getClients();
      return Response.json({
        ok: true,
        clients: clients.map(({ config }) => ({ id: config.id, model: config.model.id })),
      });
    } catch (error) {
      console.error(error);
      return Response.json({ ok: false, error: "Client config failed validation" }, { status: 500 });
    }
  },
};
