interface Env {
  WATCHDOG: DurableObjectNamespace<import("./index").Watchdog>;
  RENDER_EXTERNAL_CHECK_TOKEN: string;
}
