import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { AuthHandler } from "./auth-handler";

interface Env {
  FINNHUB_API_KEY?: string;
  METAAPI_TOKEN?: string;
  METAAPI_ACCOUNT_ID?: string;
}

type JsonObject = Record<string, unknown>;

const SUPPORTED_SYMBOLS = ["EURUSD", "GBPUSD", "XAUUSD"] as const;
const SUPPORTED_TIMEFRAMES = ["M15", "H1", "H4", "D1", "W1"] as const;

const jsonResult = (data: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(data, null, 2),
    },
  ],
});

const errorResult = (message: string) =>
  jsonResult({ error: message });

function isSupportedSymbol(symbol: string): boolean {
  return (SUPPORTED_SYMBOLS as readonly string[]).includes(
    symbol.toUpperCase(),
  );
}

function unavailable(provider: string, feature: string) {
  return {
    status: "not_configured",
    provider,
    feature,
    message:
      "Live data is unavailable until the provider is integrated and configured.",
  };
}

function calculateStats(values: number[]) {
  if (values.length === 0) {
    return { count: 0 };
  }

  const mean =
    values.reduce((sum, value) => sum + value, 0) / values.length;

  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;

  let peak = values[0];
  let maxDrawdown = 0;

  for (const value of values) {
    peak = Math.max(peak, value);

    if (peak !== 0) {
      maxDrawdown = Math.max(
        maxDrawdown,
        (peak - value) / Math.abs(peak),
      );
    }
  }

  return {
    count: values.length,
    mean,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    populationStandardDeviation: Math.sqrt(variance),
    maxDrawdownFraction: maxDrawdown,
  };
}

function calculateReturns(prices: number[]): number[] {
  const returns: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] === 0) {
      throw new Error("Prices cannot contain a zero denominator.");
    }

    returns.push(prices[i] / prices[i - 1] - 1);
  }

  return returns;
}

function makeSimulatedCandles(
  symbol: string,
  timeframe: string,
  limit: number,
) {
  const basePrices: Record<string, number> = {
    EURUSD: 1.08,
    GBPUSD: 1.27,
    XAUUSD: 2650,
  };

  const durations: Record<string, number> = {
    M15: 15 * 60_000,
    H1: 60 * 60_000,
    H4: 4 * 60 * 60_000,
    D1: 24 * 60 * 60_000,
    W1: 7 * 24 * 60 * 60_000,
  };

  const base = basePrices[symbol] ?? 100;
  const duration = durations[timeframe] ?? durations.H1;
  const now = Date.now();

  return Array.from({ length: limit }, (_, index) => {
    const step = index - limit + 1;
    const close = base * (1 + step * 0.0002);
    const open = base * (1 + (step - 0.25) * 0.0002);
    const high = Math.max(open, close) * 1.0003;
    const low = Math.min(open, close) * 0.9997;

    return {
      timestamp: new Date(now + step * duration).toISOString(),
      open,
      high,
      low,
      close,
      volume: null,
      spread: null,
    };
  });
}

async function fetchFinnhub(
  env: Env,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  if (!env.FINNHUB_API_KEY) {
    throw new Error("FINNHUB_API_KEY is not configured.");
  }

  const url = new URL(`https://finnhub.io/api/v1${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  url.searchParams.set("token", env.FINNHUB_API_KEY);

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Finnhub returned HTTP ${response.status}.`);
  }

  return response.json();
}

function getDateString(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function validNumbers(values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function registerTools(server: McpServer) {
  // Basic connectivity and authentication diagnostics.

  server.tool(
    "hello",
    "Check that the Investment Journey MCP server is responding.",
    {},
    async () =>
      jsonResult({
        message: "Investment Journey MCP server is online.",
        trading: "read-only",
      }),
  );

  server.tool(
    "whoami",
    "Return the server's current demonstration identity information.",
    {},
    async () =>
      jsonResult({
        user: "demo-user",
        name: "Demo User",
        email: "demo@example.com",
        note: "Placeholder identity; not a verified personal identity.",
      }),
  );

  server.tool(
    "get_data_status",
    "Check server, authentication, and market-data provider configuration.",
    {},
    async (_args, extra) => {
      const env = (extra as unknown as { env?: Env }).env ?? {};

      return jsonResult({
        server: "online",
        authentication: "OAuth enabled",
        providers: {
          metaapi: env.METAAPI_TOKEN && env.METAAPI_ACCOUNT_ID
            ? "credentials_present; integration_pending"
            : "not_configured",
          finnhub: env.FINNHUB_API_KEY
            ? "credentials_present"
            : "not_configured",
        },
        mockData: true,
        trading: "read-only; no order execution tools",
      });
    },
  );

  // Market quotes.
  // These quotes are deliberately simulated until a live quote
  // provider is integrated. Never treat them as tradable prices.

  server.tool(
    "get_market_quote",
    "Get a market quote. Current fallback quotes are simulated, not live.",
    {
      symbol: z.enum(SUPPORTED_SYMBOLS),
    },
    async ({ symbol }) => {
      const simulated: Record<
        string,
        { bid: number; ask: number }
      > = {
        EURUSD: { bid: 1.0001, ask: 1.0003 },
        GBPUSD: { bid: 1.0002, ask: 1.0005 },
        XAUUSD: { bid: 100.1, ask: 100.6 },
      };

      const quote = simulated[symbol];

      return jsonResult({
        symbol,
        ...quote,
        spread: quote.ask - quote.bid,
        data_source: "mock",
        is_simulated: true,
        warning:
          "Illustrative values only. Not live Markets4you or MetaApi prices.",
      });
    },
  );

  server.tool(
    "get_market_candles",
    "Get illustrative OHLC candles. These are simulated, not historical market data.",
    {
      symbol: z.enum(SUPPORTED_SYMBOLS),
      timeframe: z.enum(SUPPORTED_TIMEFRAMES),
      limit: z.number().int().min(1).max(10).default(5),
    },
    async ({ symbol, timeframe, limit }) =>
      jsonResult({
        symbol,
        timeframe,
        candles: makeSimulatedCandles(symbol, timeframe, limit),
        data_source: "mock",
        is_simulated: true,
        warning:
          "Do not use these candles for trading decisions, backtesting, or strategy validation.",
      }),
  );

  server.tool(
    "get_market_news",
    "Retrieve Finnhub market news when configured.",
    {
      category: z.enum(["general", "forex"]).default("general"),
      limit: z.number().int().min(1).max(10).default(5),
    },
    async ({ category, limit }, extra) => {
      const env = (extra as unknown as { env?: Env }).env ?? {};

      try {
        const result = await fetchFinnhub(env, "/news", { category });

        if (!Array.isArray(result)) {
          return errorResult("Finnhub returned an unexpected news format.");
        }

        return jsonResult({
          provider: "Finnhub",
          category,
          articles: result.slice(0, limit),
          is_simulated: false,
        });
      } catch (error) {
        return jsonResult({
          ...unavailable("Finnhub", "market_news"),
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  server.tool(
    "get_economic_calendar",
    "Retrieve Finnhub economic-calendar events for a date range.",
    {
      days_ahead: z.number().int().min(1).max(30).default(7),
    },
    async ({ days_ahead }, extra) => {
      const env = (extra as unknown as { env?: Env }).env ?? {};

      try {
        const result = await fetchFinnhub(env, "/calendar/economic", {
          from: getDateString(0),
          to: getDateString(days_ahead),
        });

        return jsonResult({
          provider: "Finnhub",
          calendar: result,
          is_simulated: false,
        });
      } catch (error) {
        return jsonResult({
          ...unavailable("Finnhub", "economic_calendar"),
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  // MetaApi-dependent tools.
  // The interface is established, but live API calls are not implemented yet.
  // Credentials alone do not mean the integration is working.

  server.tool(
    "list_symbols",
    "List broker symbols. Requires a completed MetaApi integration.",
    {
      search: z.string().max(40).optional(),
    },
    async ({ search }) =>
      jsonResult({
        ...unavailable("MetaApi", "list_symbols"),
        search: search ?? null,
        illustrative_candidates: SUPPORTED_SYMBOLS,
        note:
          "Candidates are not verified against your Markets4you account.",
      }),
  );

  server.tool(
    "symbol_info",
    "Get broker-specific symbol specifications, contract size, lot limits, and swaps.",
    {
      symbol: z.string().min(1).max(32),
    },
    async ({ symbol }) =>
      jsonResult({
        ...unavailable("MetaApi", "symbol_info"),
        symbol: symbol.toUpperCase(),
        required_fields: [
          "contractSize",
          "minVolume",
          "maxVolume",
          "volumeStep",
          "digits",
          "tickSize",
          "tickValue",
          "swapLong",
          "swapShort",
          "tradeMode",
        ],
        note: "No broker specifications have been invented.",
      }),
  );

  server.tool(
    "get_ticks",
    "Get live bid/ask ticks. Requires a completed MetaApi integration.",
    {
      symbol: z.string().min(1).max(32),
      limit: z.number().int().min(1).max(100).default(10),
      cursor: z.number().int().min(0).default(0),
    },
    async ({ symbol, limit, cursor }) =>
      jsonResult({
        ...unavailable("MetaApi", "get_ticks"),
        symbol: symbol.toUpperCase(),
        limit,
        cursor,
        next_cursor: null,
        ticks: [],
      }),
  );

  server.tool(
    "get_rates",
    "Get historical OHLC rates. Requires a completed MetaApi integration.",
    {
      symbol: z.string().min(1).max(32),
      timeframe: z.enum(SUPPORTED_TIMEFRAMES),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.number().int().min(0).default(0),
    },
    async ({ symbol, timeframe, limit, cursor }) =>
      jsonResult({
        ...unavailable("MetaApi", "get_rates"),
        symbol: symbol.toUpperCase(),
        timeframe,
        limit,
        cursor,
        next_cursor: null,
        rates: [],
      }),
  );

  server.tool(
    "get_market_specs",
    "Get broker-specific trading specifications. Requires MetaApi integration.",
    {
      symbol: z.string().min(1).max(32),
    },
    async ({ symbol }) =>
      jsonResult({
        ...unavailable("MetaApi", "market_specs"),
        symbol: symbol.toUpperCase(),
      }),
  );

  server.tool(
    "spread_profile",
    "Analyze historical spread by hour of day. Requires real tick history.",
    {
      symbol: z.string().min(1).max(32),
      days: z.number().int().min(1).max(90).default(14),
    },
    async ({ symbol, days }) =>
      jsonResult({
        ...unavailable("MetaApi", "spread_profile"),
        symbol: symbol.toUpperCase(),
        days,
        hourly_spreads: [],
      }),
  );

  server.tool(
    "history_coverage",
    "Check the available history range by timeframe. Requires MetaApi integration.",
    {
      symbol: z.string().min(1).max(32),
    },
    async ({ symbol }) =>
      jsonResult({
        ...unavailable("MetaApi", "history_coverage"),
        symbol: symbol.toUpperCase(),
        coverage: [],
      }),
  );

  // Quantitative analysis tools.
  // These calculate only from the data explicitly provided to them.

  server.tool(
    "run_quant_equations",
    "Calculate descriptive statistics, returns, volatility, and drawdown from supplied numeric data.",
    {
      operation: z.enum([
        "statistics",
        "returns",
        "volatility",
        "max_drawdown",
      ]),
      values: z.array(
        z.number().refine(Number.isFinite, "Values must be finite."),
      ).min(1).max(1000),
      periods_per_year: z.number().int().min(1).max(100000).default(252),
    },
    async ({ operation, values, periods_per_year }) => {
      if (!validNumbers(values)) {
        return errorResult("All values must be finite numbers.");
      }

      try {
        if (operation === "statistics") {
          return jsonResult({
            operation,
            results: calculateStats(values),
            note: "Descriptive statistics of the supplied values.",
          });
        }

        if (operation === "returns") {
          return jsonResult({
            operation,
            returns: calculateReturns(values),
            note:
              "Simple period returns: current value divided by prior value, minus one.",
          });
        }

        if (operation === "volatility") {
          const returns = calculateReturns(values);

          if (returns.length < 2) {
            return errorResult(
              "At least three price observations are required to estimate return volatility.",
            );
          }

          const stats = calculateStats(returns);
          const annualized =
            (stats.populationStandardDeviation ?? 0) *
            Math.sqrt(periods_per_year);

          return jsonResult({
            operation,
            observations: values.length,
            return_observations: returns.length,
            period_volatility: stats.populationStandardDeviation,
            annualized_volatility: annualized,
            periods_per_year,
            note:
              "Uses population standard deviation of simple returns. Annualization assumes the supplied period frequency is correct.",
          });
        }

        if (values.some((value) => value < 0)) {
          return errorResult(
            "Drawdown calculation expects a non-negative equity or portfolio-value series.",
          );
        }

        let peak = values[0];
        let maxDrawdown = 0;

        for (const value of values) {
          peak = Math.max(peak, value);

          if (peak > 0) {
            maxDrawdown = Math.max(
              maxDrawdown,
              (peak - value) / peak,
            );
          }
        }

        return jsonResult({
          operation,
          max_drawdown_fraction: maxDrawdown,
          max_drawdown_percent: maxDrawdown * 100,
          note:
            "Calculated from the supplied value series; this is not a forecast.",
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Calculation failed.",
        );
      }
    },
  );

  server.tool(
    "get_market_summary",
    "Summarize a supplied price series. Does not fetch market data.",
    {
      symbol: z.string().min(1).max(32),
      prices: z.array(z.number().refine(Number.isFinite)).min(2).max(1000),
    },
    async ({ symbol, prices }) => {
      const first = prices[0];
      const last = prices[prices.length - 1];

      if (!validNumbers(prices) || first === 0) {
        return errorResult("Prices must be finite and the first price non-zero.");
      }

      return jsonResult({
        symbol: symbol.toUpperCase(),
        observations: prices.length,
        first_price: first,
        latest_price: last,
        absolute_change: last - first,
        percentage_change: ((last / first) - 1) * 100,
        statistics: calculateStats(prices),
        data_source: "user_supplied",
        note: "Summary only; no live market data was fetched.",
      });
    },
  );

  server.tool(
    "compare_instruments",
    "Compare supplied instrument prices and returns without fetching live quotes.",
    {
      instruments: z.array(
        z.object({
          symbol: z.string().min(1).max(32),
          start_price: z.number().refine(Number.isFinite),
          end_price: z.number().refine(Number.isFinite),
        }),
      ).min(2).max(20),
    },
    async ({ instruments }) => {
      const comparisons = instruments.map((item) => {
        if (item.start_price === 0) {
          return {
            symbol: item.symbol,
            error: "Start price cannot be zero.",
          };
        }

        return {
          symbol: item.symbol.toUpperCase(),
          start_price: item.start_price,
          end_price: item.end_price,
          absolute_change: item.end_price - item.start_price,
          percentage_change:
            ((item.end_price / item.start_price) - 1) * 100,
        };
      });

      return jsonResult({
        comparisons,
        data_source: "user_supplied",
        note:
          "Compares the supplied prices only. Different instruments may have different units, contract specifications, and risk profiles.",
      });
    },
  );
}

function createServer() {
  const server = new McpServer({
    name: "investment-journey",
    version: "1.0.0",
  });

  registerTools(server);

  return server;
}

const mcpHandler = createMcpHandler(createServer);

const apiHandler = {
  fetch(
    request: Request,
    env: unknown,
    ctx: ExecutionContext,
  ) {
    return mcpHandler(request, env, ctx);
  },
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: {
    async fetch(
      request: Request,
      env: unknown,
      ctx: ExecutionContext,
    ) {
      return AuthHandler.fetch(
        request,
        env as Record<string, unknown>,
        ctx,
      );
    },
  },
});
