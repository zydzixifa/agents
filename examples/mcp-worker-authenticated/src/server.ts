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

const SUPPORTED_SYMBOLS = ["EURUSD", "GBPUSD", "XAUUSD"] as const;
const SUPPORTED_TIMEFRAMES = ["M15", "H1", "H4", "D1", "W1"] as const;

const jsonResult = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const errorResult = (message: string) =>
  jsonResult({ error: message });

const unavailable = (provider: string, feature: string) => ({
  status: "not_configured",
  provider,
  feature,
  message: "Live integration is not implemented or configured.",
});

function validNumbers(values: number[]): boolean {
  return values.every(Number.isFinite);
}

function calculateStats(values: number[]) {
  const mean =
    values.reduce((sum, value) => sum + value, 0) / values.length;

  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;

  let peak = values[0];
  let maxDrawdown = 0;

  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
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
    M15: 900_000,
    H1: 3_600_000,
    H4: 14_400_000,
    D1: 86_400_000,
    W1: 604_800_000,
  };

  const base = basePrices[symbol] ?? 100;
  const duration = durations[timeframe] ?? durations.H1;
  const now = Date.now();

  return Array.from({ length: limit }, (_, index) => {
    const step = index - limit + 1;
    const close = base * (1 + step * 0.0002);
    const open = base * (1 + (step - 0.25) * 0.0002);

    return {
      timestamp: new Date(now + step * duration).toISOString(),
      open,
      high: Math.max(open, close) * 1.0003,
      low: Math.min(open, close) * 0.9997,
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

function dateString(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function createServer() {
  const server = new McpServer({
    name: "investment-journey",
    version: "1.0.0",
  });

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
    "Return demonstration identity information.",
    {},
    async () =>
      jsonResult({
        user: "demo-user",
        name: "Demo User",
        email: "demo@example.com",
        note: "Placeholder identity, not a verified personal identity.",
      }),
  );

  server.tool(
    "get_data_status",
    "Check server and data provider integration status.",
    {},
    async () =>
      jsonResult({
        server: "online",
        authentication: "OAuth enabled",
        providers: {
          metaapi: "not_integrated",
          finnhub: "integration_pending",
        },
        trading: "read-only; no order execution tools",
        mockData: true,
      }),
  );

  server.tool(
    "get_market_quote",
    "Get an explicitly simulated quote; this is not a live market price.",
    { symbol: z.enum(SUPPORTED_SYMBOLS) },
    async ({ symbol }) => {
      const quotes: Record<string, { bid: number; ask: number }> = {
        EURUSD: { bid: 1.0001, ask: 1.0003 },
        GBPUSD: { bid: 1.0002, ask: 1.0005 },
        XAUUSD: { bid: 100.1, ask: 100.6 },
      };

      const quote = quotes[symbol];

      return jsonResult({
        symbol,
        ...quote,
        spread: quote.ask - quote.bid,
        data_source: "mock",
        is_simulated: true,
        warning: "Illustrative values only; not live Markets4you prices.",
      });
    },
  );

  server.tool(
    "get_market_candles",
    "Get simulated OHLC candles, not real historical market data.",
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
        warning: "Do not use for trading, backtesting, or strategy validation.",
      }),
  );

  server.tool(
    "get_market_news",
    "Retrieve Finnhub market news when its API key is configured.",
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
    "Retrieve economic-calendar events from Finnhub.",
    {
      days_ahead: z.number().int().min(1).max(30).default(7),
    },
    async ({ days_ahead }, extra) => {
      const env = (extra as unknown as { env?: Env }).env ?? {};

      try {
        const calendar = await fetchFinnhub(env, "/calendar/economic", {
          from: dateString(0),
          to: dateString(days_ahead),
        });

        return jsonResult({
          provider: "Finnhub",
          calendar,
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

  server.tool(
    "list_symbols",
    "List available broker symbols; MetaApi integration is pending.",
    { search: z.string().max(40).optional() },
    async ({ search }) =>
      jsonResult({
        ...unavailable("MetaApi", "list_symbols"),
        search: search ?? null,
        illustrative_candidates: SUPPORTED_SYMBOLS,
        note: "Candidates are not verified against Markets4you.",
      }),
  );

  server.tool(
    "symbol_info",
    "Retrieve broker-specific contract specifications when integrated.",
    { symbol: z.string().min(1).max(32) },
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
      }),
  );

  server.tool(
    "get_ticks",
    "Retrieve live bid/ask ticks when MetaApi is integrated.",
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
    "Retrieve historical OHLC rates when MetaApi is integrated.",
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
    "Retrieve broker-specific trading specifications.",
    { symbol: z.string().min(1).max(32) },
    async ({ symbol }) =>
      jsonResult({
        ...unavailable("MetaApi", "market_specs"),
        symbol: symbol.toUpperCase(),
      }),
  );

  server.tool(
    "spread_profile",
    "Analyze spreads by hour using real tick history when integrated.",
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
    "Check available historical coverage by timeframe.",
    { symbol: z.string().min(1).max(32) },
    async ({ symbol }) =>
      jsonResult({
        ...unavailable("MetaApi", "history_coverage"),
        symbol: symbol.toUpperCase(),
        coverage: [],
      }),
  );

  server.tool(
    "run_quant_equations",
    "Calculate statistics, returns, volatility, or maximum drawdown from supplied numbers.",
    {
      operation: z.enum([
        "statistics",
        "returns",
        "volatility",
        "max_drawdown",
      ]),
      values: z.array(z.number()).min(1).max(1000),
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
          });
        }

        if (operation === "returns") {
          return jsonResult({
            operation,
            returns: calculateReturns(values),
          });
        }

        if (operation === "volatility") {
          const returns = calculateReturns(values);

          if (returns.length < 2) {
            return errorResult(
              "At least three price observations are required.",
            );
          }

          const stats = calculateStats(returns);
          const periodVolatility =
            stats.populationStandardDeviation ?? 0;

          return jsonResult({
            operation,
            observations: values.length,
            return_observations: returns.length,
            period_volatility: periodVolatility,
            annualized_volatility:
              periodVolatility * Math.sqrt(periods_per_year),
            periods_per_year,
            note: "Annualization depends on the supplied data frequency.",
          });
        }

        if (values.some((value) => value < 0)) {
          return errorResult(
            "Drawdown expects a non-negative equity or portfolio-value series.",
          );
        }

        let peak = values[0];
        let maxDrawdown = 0;

        for (const value of values) {
          peak = Math.max(peak, value);

          if (peak > 0) {
            maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
          }
        }

        return jsonResult({
          operation,
          max_drawdown_fraction: maxDrawdown,
          max_drawdown_percent: maxDrawdown * 100,
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
    "Summarize a supplied price series without fetching live data.",
    {
      symbol: z.string().min(1).max(32),
      prices: z.array(z.number()).min(2).max(1000),
    },
    async ({ symbol, prices }) => {
      if (!validNumbers(prices) || prices[0] === 0) {
        return errorResult(
          "Prices must be finite and the first price must be non-zero.",
        );
      }

      const first = prices[0];
      const last = prices[prices.length - 1];

      return jsonResult({
        symbol: symbol.toUpperCase(),
        observations: prices.length,
        first_price: first,
        latest_price: last,
        absolute_change: last - first,
        percentage_change: ((last / first) - 1) * 100,
        statistics: calculateStats(prices),
        data_source: "user_supplied",
      });
    },
  );

  server.tool(
    "compare_instruments",
    "Compare supplied instrument prices without fetching live quotes.",
    {
      instruments: z.array(
        z.object({
          symbol: z.string().min(1).max(32),
          start_price: z.number(),
          end_price: z.number(),
        }),
      ).min(2).max(20),
    },
    async ({ instruments }) => {
      if (
        !instruments.every(
          (item) =>
            Number.isFinite(item.start_price) &&
            Number.isFinite(item.end_price),
        )
      ) {
        return errorResult("All prices must be finite numbers.");
      }

      return jsonResult({
        comparisons: instruments.map((item) => {
          if (item.start_price === 0) {
            return {
              symbol: item.symbol.toUpperCase(),
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
        }),
        data_source: "user_supplied",
        note: "Different instruments may have different units and risks.",
      });
    },
  );

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
