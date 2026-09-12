// ============================================================
// Lukas Alarm Watchdog — Cloudflare Durable Object
//
// Внешний независимый контроль Render-бота (bot.py).
//
// Разделение ответственности (см. ТЗ):
//   - Этот Worker ТОЛЬКО опрашивает /external-check у Render
//     и ведёт FSM NORMAL -> SUSPECTED -> DEAD.
//   - Он отправляет в Telegram ровно два типа сообщений:
//     "подозрение" (через 40 сек) и "система не работает"
//     (через 80 сек). Больше ничего и никогда.
//   - Сообщение о восстановлении Watchdog НИКОГДА не отправляет.
//     Восстановление после DEAD подтверждает сам bot.py через
//     свой собственный внутренний watchdog (уже реализовано).
//     Восстановление из SUSPECTED (не дошедшее до DEAD) бот
//     подтверждает через endpoint /external-recovered, который
//     этот Worker вызывает один раз в момент такого восстановления.
// ============================================================

const RENDER_BASE_URL = "https://lukas-alarm-bot-1.onrender.com";
const RENDER_CHECK_URL = `${RENDER_BASE_URL}/external-check`;
const RENDER_RECOVERED_URL = `${RENDER_BASE_URL}/external-recovered`;

// Единая временная шкала одного инцидента (см. п.11 ТЗ):
//   40 сек = 15 + 15 + 10 (два цикла парсера + запас)
//   80 сек = 40 + 15 + 15 + 10
const SUSPECTED_THRESHOLD_MS = 40_000;
const DEAD_THRESHOLD_MS = 80_000;

// Интервал Durable Object Alarm.
const ALARM_INTERVAL_MS = 10_000;

// Таймаут одного внешнего запроса к Render — заметно меньше
// интервала Alarm, чтобы проверки не накладывались друг на друга.
const FETCH_TIMEOUT_MS = 8_000;

const STATE_STORAGE_KEY = "watchdog_state";

type WatchdogStatus = "NORMAL" | "SUSPECTED" | "DEAD";

interface WatchdogState {
  status: WatchdogStatus;
  failureStartedAt: number | null;
  lastCheckAt: number | null;
  lastSuccessAt: number | null;
  incidentReason: string | null;
}

const DEFAULT_STATE: WatchdogState = {
  status: "NORMAL",
  failureStartedAt: null,
  lastCheckAt: null,
  lastSuccessAt: null,
  incidentReason: null,
};

type CheckResult =
  | { ok: true }
  | { ok: false; reason: string; httpStatus?: number };

// ------------------------------------------------------------
// Тексты сообщений отдельно от логики (см. п.26 ТЗ).
// Смысл менять нельзя (жёстко задан ТЗ), но форматирование —
// можно, не трогая FSM ниже.
// ------------------------------------------------------------

const MESSAGES = {
  suspected: (reason: string): string =>
    "⚠️ ПРОВЕРКА СИСТЕМЫ\n" +
    "\n" +
    "Подозрение на работоспособность системы.\n" +
    "\n" +
    "Внешняя проверка не может подтвердить работу бота уже " +
    `более ${SUSPECTED_THRESHOLD_MS / 1000} секунд.\n` +
    `Причина: ${reason}`,

  dead: (reason: string): string =>
    "🔴 СИСТЕМА НЕ РАБОТАЕТ\n" +
    "\n" +
    "Система не работает.\n" +
    "\n" +
    "Внешняя проверка не может подтвердить работу бота уже " +
    `более ${DEAD_THRESHOLD_MS / 1000} секунд.\n` +
    `Причина: ${reason}\n` +
    "\n" +
    "На уведомления бота сейчас нельзя рассчитывать.",
};

export class Watchdog {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    // Гарантируем, что Alarm запланирован сразу же при первом
    // создании Durable Object (например, при первом запросе
    // к Worker'у или первом срабатывании Cron Trigger'а).
    // Дальше alarm() сам себя перепланирует.
    this.state.blockConcurrencyWhile(async () => {
      const existingAlarm = await this.state.storage.getAlarm();

      if (existingAlarm === null) {
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      return this.handleManualCheck();
    }

    if (url.pathname === "/") {
      return new Response("Lukas Alarm Watchdog OK", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      });
    }

    if (url.pathname === "/ensure-alarm") {
      // Технический маршрут для Cron Trigger'а — только гарантирует,
      // что Durable Object создан и Alarm запланирован (см. constructor
      // выше). Никакой проверки и никакой отправки сообщений не делает.
      return new Response("ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }

  // ----------------------------------------------------------
  // /check — РУЧНАЯ проверка (п.18 ТЗ).
  //
  // Делает тот же внешний запрос к Render, что и автоматический
  // Alarm, но НИКОГДА не изменяет сохранённое состояние FSM и
  // никогда не отправляет сообщения в Telegram. Она не должна
  // случайно сбросить или сломать автоматический watchdog.
  // ----------------------------------------------------------

  private async handleManualCheck(): Promise<Response> {
    const result = await this.performExternalCheck();
    const stored = await this.loadState();

    if (result.ok) {
      return Response.json({
        ok: true,
        render_status: 200,
        watchdog_state: stored,
      });
    }

    return Response.json(
      {
        ok: false,
        reason: result.reason,
        render_status: result.httpStatus ?? null,
        watchdog_state: stored,
      },
      { status: result.httpStatus === 503 ? 200 : 502 },
    );
  }

  // ----------------------------------------------------------
  // Durable Object Alarm — автоматический цикл контроля (п.12 ТЗ).
  // ----------------------------------------------------------

  async alarm(): Promise<void> {
    // Планируем следующий тик от МОМЕНТА НАЧАЛА текущей проверки,
    // а не от момента её завершения. Сама проверка может занимать
    // до FETCH_TIMEOUT_MS (8 сек) плюс обработку — если бы отсчёт
    // следующего интервала начинался только после этого, реальный
    // период между тиками мог бы растягиваться далеко за
    // ALARM_INTERVAL_MS, а вместе с ним — и фактическое срабатывание
    // порогов 40/80 сек (elapsed считается от failureStartedAt по
    // Date.now(), но сами тики, приносящие эти замеры, стали бы
    // реже). Привязка к tickStartedAt убирает этот дрейф.
    const tickStartedAt = Date.now();

    try {
      await this.runAutomaticCheck();
    } catch (error) {
      console.error(
        "Watchdog alarm error:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      // Одна ошибка цикла не должна остановить весь watchdog —
      // следующий Alarm планируется независимо от результата.
      // Math.max защищает от планирования в прошлом, если сама
      // проверка (включая немедленный recheck после SUSPECTED)
      // неожиданно заняла дольше ALARM_INTERVAL_MS — тогда
      // следующий тик выполняется как можно скорее, а не пропускается.
      const nextAlarmAt = tickStartedAt + ALARM_INTERVAL_MS;
      await this.state.storage.setAlarm(Math.max(nextAlarmAt, Date.now()));
    }
  }

  private async runAutomaticCheck(): Promise<void> {
    const now = Date.now();
    const result = await this.performExternalCheck();
    const stored = await this.loadState();

    if (result.ok) {
      await this.handleSuccess(stored, now);
    } else {
      await this.handleFailure(stored, now, result.reason);
    }
  }

  // ----------------------------------------------------------
  // FSM
  // ----------------------------------------------------------

  private async handleSuccess(
    stored: WatchdogState,
    now: number,
  ): Promise<void> {
    const previousStatus = stored.status;

    const next: WatchdogState = {
      status: "NORMAL",
      failureStartedAt: null,
      lastCheckAt: now,
      lastSuccessAt: now,
      incidentReason: null,
    };

    await this.saveState(next);

    if (previousStatus === "SUSPECTED") {
      // Инцидент не успел дойти до DEAD. Watchdog сам ничего не
      // пишет в Telegram (п.5, п.7 ТЗ) — только сообщает боту,
      // что тот может подтвердить свою работоспособность сам.
      await this.notifyBotRecovered();
    }

    // DEAD -> NORMAL: Watchdog молчит (п.10 ТЗ). Сообщение о
    // восстановлении после подтверждённого отказа отправляет
    // сам bot.py через собственный внутренний watchdog.
  }

  private async handleFailure(
    stored: WatchdogState,
    now: number,
    reason: string,
  ): Promise<void> {
    const failureStartedAt = stored.failureStartedAt ?? now;
    const elapsed = now - failureStartedAt;

    let status = stored.status;

    if (elapsed >= DEAD_THRESHOLD_MS) {
      if (status !== "DEAD") {
        await this.sendTelegramMessage(MESSAGES.dead(reason));
        status = "DEAD";
      }

      await this.saveState({
        status,
        failureStartedAt,
        lastCheckAt: now,
        lastSuccessAt: stored.lastSuccessAt,
        incidentReason: reason,
      });

      return;
    }

    if (elapsed >= SUSPECTED_THRESHOLD_MS && status === "NORMAL") {
      await this.sendTelegramMessage(MESSAGES.suspected(reason));
      status = "SUSPECTED";

      // Сообщение SUSPECTED — это не просто уведомление, а сигнал
      // для bot.py немедленно выполнить самодиагностику и
      // подтвердить работоспособность (см. ТЗ), а не пассивное
      // ожидание следующего планового тика Alarm через 10 секунд.
      // Используем тот же самый /external-check — самодиагностика
      // уже встроена в него на стороне bot.py, отдельный endpoint
      // не нужен.
      const immediateRecheck = await this.performExternalCheck();

      if (immediateRecheck.ok) {
        // Бот сразу подтвердил работоспособность — инцидент закрыт
        // немедленно, тем же путём, что и обычное восстановление
        // из SUSPECTED (без сообщения от Watchdog, с уведомлением
        // бота через /external-recovered).
        await this.handleSuccess(
          { ...stored, status: "SUSPECTED" },
          Date.now(),
        );

        return;
      }

      // Немедленного подтверждения не было — инцидент продолжается,
      // дальше действует обычная FSM по плановым тикам Alarm.
      reason = immediateRecheck.reason;
    }

    await this.saveState({
      status,
      failureStartedAt,
      lastCheckAt: now,
      lastSuccessAt: stored.lastSuccessAt,
      incidentReason: reason,
    });
  }

  // ----------------------------------------------------------
  // Состояние (Durable Object Storage, п.16 ТЗ)
  // ----------------------------------------------------------

  private async loadState(): Promise<WatchdogState> {
    const stored = await this.state.storage.get<WatchdogState>(
      STATE_STORAGE_KEY,
    );

    return stored ?? DEFAULT_STATE;
  }

  private async saveState(next: WatchdogState): Promise<void> {
    await this.state.storage.put(STATE_STORAGE_KEY, next);
  }

  // ----------------------------------------------------------
  // Внешняя проверка Render-бота
  // ----------------------------------------------------------

  private async performExternalCheck(): Promise<CheckResult> {
    const token = this.env.RENDER_EXTERNAL_CHECK_TOKEN;

    if (!token) {
      console.error("RENDER_EXTERNAL_CHECK_TOKEN is not configured");
      return { ok: false, reason: "Watchdog secret is not configured" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(RENDER_CHECK_URL, {
        method: "GET",
        headers: { "X-External-Check-Token": token },
        signal: controller.signal,
      });

      if (response.status === 200) {
        return { ok: true };
      }

      // HTTP 503 — бот сам сообщает о своей проблеме. Это не
      // мгновенный DEAD (п.14 ТЗ), а обычный failed-check,
      // который дальше идёт через общую FSM.
      if (response.status === 503) {
        const reason = await this.extractReason(response, "HTTP 503");
        return { ok: false, reason, httpStatus: 503 };
      }

      console.error(`Unexpected Render response: ${response.status}`);

      return {
        ok: false,
        reason: `HTTP ${response.status}`,
        httpStatus: response.status,
      };
    } catch (error) {
      // Таймаут или сетевая ошибка (п.15 ТЗ) — не мгновенный DEAD,
      // а начало/продолжение обычного инцидента.
      const isAbort = error instanceof Error && error.name === "AbortError";
      return { ok: false, reason: isAbort ? "timeout" : "network error" };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async extractReason(
    response: Response,
    fallback: string,
  ): Promise<string> {
    try {
      const text = await response.text();
      const data = JSON.parse(text) as { reason?: unknown };

      if (typeof data.reason === "string" && data.reason.trim()) {
        return data.reason;
      }
    } catch {
      // Тело не JSON или отсутствует — используем fallback,
      // не придумывая причину (п.17 ТЗ).
    }

    return fallback;
  }

  // ----------------------------------------------------------
  // Уведомление бота о восстановлении из SUSPECTED (до DEAD).
  // Сообщение пользователю в этом случае отправляет сам bot.py
  // через /external-recovered — не Watchdog.
  // ----------------------------------------------------------

  private async notifyBotRecovered(): Promise<void> {
    const token = this.env.RENDER_EXTERNAL_CHECK_TOKEN;

    if (!token) {
      return;
    }

    try {
      await fetch(RENDER_RECOVERED_URL, {
        method: "POST",
        headers: { "X-External-Check-Token": token },
      });
    } catch (error) {
      console.error(
        "Failed to notify bot about recovery:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ----------------------------------------------------------
  // Telegram — только два сообщения на весь жизненный цикл
  // Watchdog (п.3 ТЗ). Секреты (токен) никогда не логируются
  // и не возвращаются наружу (п.29 ТЗ).
  // ----------------------------------------------------------

  private async sendTelegramMessage(text: string): Promise<void> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.error("Telegram credentials are not configured for Watchdog");
      return;
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
          }),
        },
      );

      if (!response.ok) {
        console.error(
          `Telegram sendMessage failed: HTTP ${response.status}`,
        );
      }
    } catch (error) {
      console.error(
        "Telegram sendMessage error:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Все запросы идут через один и тот же Durable Object ("main"),
    // чтобы гарантированно проходил constructor() и был запланирован
    // Alarm — включая обычный "/".
    const id = env.WATCHDOG.idFromName("main");
    const stub = env.WATCHDOG.get(id);

    return stub.fetch(request);
  },

  // Cron Trigger (см. wrangler.json) — подстраховка на случай,
  // если по Worker'у долго нет обычного трафика: гарантирует, что
  // Durable Object жив и его Alarm запланирован. Сам по себе
  // ничего не проверяет и ничего в Telegram не отправляет —
  // вся проверка выполняется внутри alarm().
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const id = env.WATCHDOG.idFromName("main");
    const stub = env.WATCHDOG.get(id);

    ctx.waitUntil(stub.fetch(new Request("https://internal/ensure-alarm")));
  },
} satisfies ExportedHandler<Env>;
