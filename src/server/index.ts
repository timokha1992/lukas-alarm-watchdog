const RENDER_URL = "https://lukas-alarm-bot-1.onrender.com/external-check";

export class Watchdog {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      return this.runCheck();
    }

    if (url.pathname === "/") {
      return new Response("Lukas Alarm Watchdog OK", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  private async runCheck(): Promise<Response> {
    const token = this.env.RENDER_EXTERNAL_CHECK_TOKEN;

    if (!token) {
      console.error("RENDER_EXTERNAL_CHECK_TOKEN is not configured");

      return Response.json(
        {
          ok: false,
          reason: "Watchdog secret is not configured",
        },
        { status: 500 },
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(RENDER_URL, {
        method: "GET",
        headers: {
          "X-External-Check-Token": token,
        },
        signal: controller.signal,
      });

      const text = await response.text();

      let data: unknown = null;

      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (response.status === 200) {
        return Response.json({
          ok: true,
          render_status: 200,
          result: data,
        });
      }

      if (response.status === 503 && data !== null) {
        return Response.json({
          ok: true,
          render_status: 503,
          bot_report: data,
        });
      }

      console.error(
        `Unexpected Render response: ${response.status}`,
      );

      return Response.json(
        {
          ok: false,
          reason: `Unexpected Render response: HTTP ${response.status}`,
        },
        { status: 502 },
      );
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Unknown network error";

      console.error("Render external check failed:", reason);

      return Response.json(
        {
          ok: false,
          reason,
        },
        { status: 502 },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      const id = env.WATCHDOG.idFromName("main");
      const stub = env.WATCHDOG.get(id);

      return stub.fetch(request);
    }

    if (url.pathname === "/") {
      return new Response("Lukas Alarm Watchdog OK", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
