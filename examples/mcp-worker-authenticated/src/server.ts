import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { AuthHandler } from "./auth-handler";
import { compactText } from "./market-filters";

interface Env {
  FINNHUB_API_KEY?: string;
  METAAPI_TOKEN?: string;
  METAAPI_ACCOUNT_ID?: string;
}

const SUPPORTED_SYMBOLS = ["EURUSD", "GBPUSD", "XAUUSD"] as const;
const TIMEFRAMES = ["M15", "H1", "H4", "D1", "W1"] as const;

type SymbolName = (typeof SUPPORTED_SYMBOLS)[number];
type Timeframe = (typeof TIMEFRAMES)[number];

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function finiteNumbers(values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function calculateStats(values: number[]) {
  if (values.length === 0 || !finiteNumbers(values)) {
    throw new Error("Provide at least one finite numeric value.");
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  const mean = sum / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    values.length;

  const median =
    sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] +
          sorted[sorted.length / 2]) /
        2;

  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median,
    populationVariance: variance,
    populationStdDev: Math.sqrt(variance),
  };
}

function calculateReturns(values: number[]) {
  if (values.length < 2) {
    throw new Error("At least two prices are required.");
  }
  if (!finiteNumbers(values)) {
    throw new Error("All prices must be finite numbers.");
  }

  const returns: number[] = [];

  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] === 0) {
      throw new Error("A previous price cannot be zero.");
    }
    returns.push(values[i] / values[i - 1] - 1);
  }

  return returns;
}

function calculateMaxDrawdown(prices: number[]) {
  if (prices.length === 0 || !finiteNumbers(prices)) {
    throw new Error("Provide a non-empty array of finite prices.");
  }

  let peak = prices[0];
  let maxDrawdown = 0;

  for (const price of prices) {
    peak = Math.max(peak, price);

    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - price) / peak);
    }
  }

  return maxDrawdown;
}

// These candles are deterministic DEMO DATA, not historical market data.
function makeSimulatedCandles(
  symbol: SymbolName,
  timeframe: Timeframe,
  count: number,
): Candle[] {
  const basePrices: Record<SymbolName, number> = {
    EURUSD: 1.08,
    GBPUSD: 1.29,
    XAUUSD: 3000,
  };

  const base = basePrices[symbol];
  const now = Date.now();
  const intervalMs: Record<Timeframe, number> = {
    M15: 15 * 60_000,
    H1: 60 * 60_000,
    H4: 4 * 60 * 60_000,
    D1: 24 * 60 * 60_000,
    W1: 7 * 24 * 60 * 60_000,
  };

  return Array.from({ length: count }, (_, index) => {
    const offset = count - index - 1;
    const wave = Math.sin(index * 1.7) * base * 0.001;
    const open = base + wave;
    const close = base + Math.sin((index + 1) * 1.7) * base * 0.001;
    const spread = base * 0.0004;

    return {
      time: new Date(now - offset * intervalMs[timeframe]).toISOString(),
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: 100 + index * 7,
    };
  });
}

async function fetchFinnhub(
  env: Env,
  path: string,
): Promise<unknown> {
  if (!env.FINNHUB_API_KEY) {
    throw new Error(
      "Finnhub is not configured. Set FINNHUB_API_KEY as a Worker secret.",
    );
  }

  const separator = path.includes("?") ? "&" : "?";
  const url =
    `https://finnhub.io/api/v1/${path}${separator}` +
    `token=${encodeURIComponent(env.FINNHUB_API_KEY)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Finnhub returned HTTP ${response.status}.`);
  }

  return response.json();
}

function getProviderStatus(env: Env) {
  return {
    finnhub: env.FINNHUB_API_KEY
      ? "configured_not_yet_verified"
      : "not_configured",
    metaapi:
      env.METAAPI_TOKEN && env.METAAPI_ACCOUNT_ID
        ? "credentials_configured_not_yet_verified"
        : "not_configured",
    quotes: "simulated_demo_data_only",
    candles: "simulated_demo_data_only",
    orderExecution: "not_available_read_only_server",
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "MetaApi Finnhub MCP",
    version: "1.0.0",
  });

  // 1. Basic health check
  server.registerTool(
    "hello",
    {
      description: "Check whether MCP tool execution is working.",
      inputSchema: {},
    },
    async () =>
      textResult({
        ok: true,
        message: "Hello! MCP tool execution is working.",
      }),
  );

  // 2. Authentication context
  server.registerTool(
    "whoami",
    {
      description: "Inspect available authenticated client metadata.",
      inputSchema: {},
    },
    async (_args, context) => {
      const auth = getMcpAuthContext();

      return textResult({
        clientId: context.http?.authInfo?.clientId ?? null,
        scopes: context.http?.authInfo?.scopes ?? [],
        propsAvailable: Boolean(auth?.props),
        note: "Access tokens and secret authentication values are never returned.",
      });
    },
  );

  // 3. Provider status
  server.registerTool(
    "get_data_status",
    {
      description:
        "Report configured providers and distinguish demo data from live data.",
      inputSchema: {},
    },
    async () =>
      textResult({
        providers: getProviderStatus(env),
        supportedSymbols: SUPPORTED_SYMBOLS,
        warning:
          "Configured credentials do not prove connectivity. No live quote or candle feed is implemented by this status tool.",
      }),
  );
  
  // 4. Quote: intentionally simulated
  server.registerTool(
    "get_market_quote",
    {
      description:
        "Return one clearly labelled simulated quote for a single supported symbol. Call only for the specific instrument needed. This is not a live market price; the timestamp is the demo generation time.",
      inputSchema: {
        symbol: z
          .enum(SUPPORTED_SYMBOLS)
          .describe("The single supported instrument to retrieve."),
      },
    },
    async ({ symbol }) =>
      textResult({
        symbol,
        source: "SIMULATED_DEMO",
        isLive: false,
        warning:
          "Demo bid/ask values are hardcoded examples, not real market prices. Do not use them for trading decisions.",
        bid: symbol === "XAUUSD" ? 3000.1 : 1.08,
        ask: symbol === "XAUUSD" ? 3000.6 : 1.0802,
        timestamp: new Date().toISOString(),
        timestampMeaning: "Demo generation time, not a market-data timestamp.",
      }),
  );
 
  // 5. Candles: intentionally simulated
  server.registerTool(
    "get_market_candles",
    {
      description:
        "Return simulated demo candles for one supported symbol and timeframe. Defaults to 20 candles, with a maximum of 500. Request only the candle count needed for the analysis. These are not real historical prices.",
      inputSchema: {
        symbol: z.enum(SUPPORTED_SYMBOLS),
        timeframe: z.enum(TIMEFRAMES),
        count: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Number of simulated candles to return; defaults to 20. Request the smallest count sufficient for the task.",
          ),
      },
    },
    async ({ symbol, timeframe, count }) =>
      textResult({
        symbol,
        timeframe,
        source: "SIMULATED_DEMO",
        isLive: false,
        candles: makeSimulatedCandles(
          symbol,
          timeframe,
          count ?? 20,
        ),
        warning:
          "Generated demonstration candles; not suitable for backtesting or trading.",
      }),
  );


  // 6. Finnhub news
  server.registerTool(
    "get_market_news",
    {
      description:
        "Retrieve compact Finnhub market news. Returns up to 10 articles by default, with a maximum of 20 and summaries capped at 500 characters. Requires FINNHUB_API_KEY.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe(
            "Finnhub news category, such as general, forex, crypto, or merger.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of articles to return; defaults to 10."),
      },
    },
    async ({ category, limit }) => {
      try {
        const safeCategory = category ?? "general";
        const maxArticles = limit ?? 10;

        const result = await fetchFinnhub(
          env,
          `news?category=${encodeURIComponent(safeCategory)}`,
        );

        if (!Array.isArray(result)) {
          return errorResult(
            "Finnhub returned an unexpected response format. Expected an array of news articles.",
          );
        }

        const articles = result
          .filter(
            (item): item is Record<string, unknown> =>
              typeof item === "object" &&
              item !== null &&
              !Array.isArray(item),
          )
          .map((item) => {
            const rawSummary = compactText(item.summary, 500);

            return {
              headline:
                typeof item.headline === "string" ? item.headline : null,
              source:
                typeof item.source === "string" ? item.source : null,
              publishedAt:
                typeof item.datetime === "number" &&
                Number.isFinite(item.datetime)
                  ? new Date(item.datetime * 1000).toISOString()
                  : null,
              url: typeof item.url === "string" ? item.url : null,
              category:
                typeof item.category === "string" ? item.category : null,
              summary:
                rawSummary === null
                  ? null
                  : rawSummary.length > 500
                    ? `${rawSummary.slice(0, 497)}...`
                    : rawSummary,
            };
          });

        const returnedArticles = articles.slice(0, maxArticles);

        return textResult({
          source: "Finnhub",
          isLive: true,
          category: safeCategory,
          articleCount: returnedArticles.length,
          matchingArticleCount: articles.length,
          limit: maxArticles,
          truncated: articles.length > returnedArticles.length,
          articles: returnedArticles,
          caveats: [
            "News and summaries are supplied by Finnhub and third-party publishers.",
            "Publication timestamps are converted from Unix seconds to ISO 8601 UTC.",
            "Summaries may be shortened; open the original article for full context.",
          ],
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Finnhub news request failed.",
        );
      }
    },
  );
 
  // 7. FinanceCalendar economic calendar
  server.registerTool(
    "get_economic_calendar",
    {
      description:
        "Retrieve economic events from FinanceCalendar for a date range, optionally filtered by impact. Returns provider-supplied event data, with missing values preserved as null and source attribution included. This is a third-party calendar, not broker data.",
      inputSchema: {
        from: z.string().describe("Start date in YYYY-MM-DD format."),
        to: z.string().describe("End date in YYYY-MM-DD format."),
        impact: z
          .enum(["all", "low", "medium", "high"])
          .optional()
          .describe("Optional impact filter; defaults to all."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of returned events; defaults to 50."),
      },
    },
    async ({ from, to, impact, limit }) => {
      const parseDate = (value: string): number | null => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return null;
        }

        const timestamp = Date.parse(`${value}T00:00:00Z`);
        if (!Number.isFinite(timestamp)) {
          return null;
        }

        return new Date(timestamp).toISOString().slice(0, 10) === value
          ? timestamp
          : null;
      };

      const fromMs = parseDate(from);
      const toMs = parseDate(to);

      if (fromMs === null || toMs === null) {
        return errorResult(
          "Invalid date. Both dates must be real calendar dates in YYYY-MM-DD format.",
        );
      }

      if (fromMs > toMs) {
        return errorResult(
          "The start date must be on or before the end date.",
        );
      }

      const dayCount = (toMs - fromMs) / 86_400_000 + 1;
      if (dayCount > 62) {
        return errorResult(
          "Date range is too large. Request no more than 62 calendar days at a time.",
        );
      }

      const maxEvents = limit ?? 50;
      const selectedImpact = impact ?? "all";

      try {
        const url = new URL(
          "https://www.financecalendar.com/wp-json/fc/v1/calendar",
        );
        url.searchParams.set("from", from);
        url.searchParams.set("to", to);

        // Ask the provider to filter when supported; also filter locally
        // below so the returned events obey the requested impact.
        if (selectedImpact !== "all") {
          url.searchParams.set("impact", selectedImpact);
        }

        const response = await fetch(url.toString(), {
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          return errorResult(
            `FinanceCalendar returned HTTP ${response.status}. The calendar request could not be completed.`,
          );
        }

        const payload: unknown = await response.json();

        if (
          typeof payload !== "object" ||
          payload === null ||
          !("events" in payload) ||
          !Array.isArray(payload.events)
        ) {
          return errorResult(
            "FinanceCalendar returned an unexpected response format. Expected an object containing an events array.",
          );
        }

        const events = payload.events.filter(
          (event): event is Record<string, unknown> =>
            typeof event === "object" &&
            event !== null &&
            !Array.isArray(event),
        );

        const normalized = events
          .filter((event) => {
            const eventImpact =
              typeof event.impact === "string"
                ? event.impact.toLowerCase()
                : "";

            return (
              selectedImpact === "all" ||
              eventImpact === selectedImpact
            );
          })
          .map((event) => ({
            date: event.date ?? null,
            timeUtc: event.time_utc ?? null,
            allDay: event.all_day ?? false,
            name: event.name ?? null,
            title: event.title ?? null,
            impact: event.impact ?? null,
            category: event.category ?? null,
            consensus: event.consensus ?? null,
            prior: event.prior ?? null,
            actual: event.actual ?? null,
            url: event.url ?? null,
          }));

        const returnedEvents = normalized.slice(0, maxEvents);

        return textResult({
          source: "FinanceCalendar",
          isLive: true,
          requestedRange: { from, to },
          impactFilter: selectedImpact,
          eventCount: returnedEvents.length,
          matchingEventCount: normalized.length,
          truncated: normalized.length > returnedEvents.length,
          events: returnedEvents,
          attribution: {
            source: "FinanceCalendar",
            url: "https://www.financecalendar.com",
            terms:
              "Free for any use with attribution. Include a link to FinanceCalendar.",
            documentation: "https://www.financecalendar.com/api/",
          },
          caveats: [
            "Events and economic figures are provider-supplied and have not been independently verified.",
            "A null event time means the provider did not supply a time.",
            "Null consensus, prior, or actual values mean the data was unavailable; they must not be interpreted as zero.",
            "This calendar does not provide broker quotes or guarantee that every relevant event is included.",
          ],
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? `FinanceCalendar request failed: ${error.message}`
            : "FinanceCalendar request failed unexpectedly.",
        );
      }
    },
  );  
  
  // 8. Supported symbols
  server.registerTool(
    "list_symbols",
    {
      description:
        "List supported symbols, optionally filtering by a case-insensitive substring. Use the search filter when looking for a specific instrument. This is the server's configured list, not a verified broker symbol list.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe(
            "Optional case-insensitive search text, such as EUR, GBP, or XAU.",
          ),
      },
    },
    async ({ search }) => {
      const query = search?.trim().toUpperCase();

      const symbols = query
        ? SUPPORTED_SYMBOLS.filter((symbol) =>
            symbol.toUpperCase().includes(query),
          )
        : SUPPORTED_SYMBOLS;

      return textResult({
        symbols,
        count: symbols.length,
        search: query || null,
        note:
          "This is the server's configured symbol list, not a verified broker symbol list.",
      });
    },
  );
  
  // 9. Symbol information
  server.registerTool(
    "symbol_info",
    {
      description:
        "Return configuration and verification status for one supported symbol. This does not provide verified broker contract specifications, live prices, or proof that the symbol is tradable.",
      inputSchema: {
        symbol: z
          .enum(SUPPORTED_SYMBOLS)
          .describe("The single supported symbol to inspect."),
      },
    },
    async ({ symbol }) =>
      textResult({
        symbol,
        configured: true,
        brokerVerified: false,
        marketDataVerified: false,
        specificationsAvailable: false,
        note:
          "Only server configuration is confirmed. Broker-specific contract details and market-data availability have not been retrieved from MetaApi.",
      }),
  );
  
  // 10. Ticks: MetaApi not yet integrated
  server.registerTool(
    "get_ticks",
    {
      description:
        "Placeholder only: live tick retrieval is not implemented because MetaApi is not integrated. Calling this tool will not retrieve market data.",
      inputSchema: {
        symbol: z.enum(SUPPORTED_SYMBOLS),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(
            "Reserved for the future implementation; maximum 1000 ticks per request.",
          ),
      },
    },
    async ({ symbol }) =>
      errorResult(
        `Live tick retrieval is not implemented for ${symbol}. MetaApi is not integrated; no live tick data was retrieved.`,
      ),
  );

  // 11. Rates: MetaApi not yet integrated
  server.registerTool(
    "get_rates",
    {
      description:
        "Placeholder only: historical broker-rate retrieval is not implemented because MetaApi is not integrated. This tool does not return historical prices.",
      inputSchema: {
        symbol: z.enum(SUPPORTED_SYMBOLS),
        timeframe: z.enum(TIMEFRAMES),
        count: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe(
            "Reserved for the future implementation; maximum 5000 rates per request.",
          ),
      },
    },
    async ({ symbol, timeframe }) =>
      errorResult(
        `Historical-rate retrieval is not implemented for ${symbol} on ${timeframe}. MetaApi is not integrated; no historical rates were retrieved. Use get_market_candles only for clearly labelled simulated demo data.`,
      ),
  );
  
  // 12. Market specifications: MetaApi not yet integrated
  server.registerTool(
    "get_market_specs",
    {
      description:
        "Placeholder only: verified broker contract specifications are not available because MetaApi integration has not been implemented. This tool does not return actual trading specifications.",
      inputSchema: {
        symbol: z
          .enum(SUPPORTED_SYMBOLS)
          .describe("The single supported instrument to inspect."),
      },
    },
    async ({ symbol }) =>
      errorResult(
        `Verified broker contract specifications are unavailable for ${symbol}. MetaApi integration has not been implemented and verified; no actual contract specifications were retrieved.`,
      ),
  );
  
  // 13. Spread profile: real tick data not yet integrated
  server.registerTool(
    "spread_profile",
    {
      description:
        "Placeholder only: historical spread analysis is unavailable until real broker bid/ask tick history is integrated and verified. This tool does not calculate actual spreads.",
      inputSchema: {
        symbol: z
          .enum(SUPPORTED_SYMBOLS)
          .describe("The single supported instrument to inspect."),
      },
    },
    async ({ symbol }) =>
      errorResult(
        `Spread profiling is unavailable for ${symbol}. Real broker tick data and historical bid/ask records are not yet integrated; no spread analysis was performed.`,
      ),
  );

  // 14. History coverage: broker history retrieval not yet integrated
  server.registerTool(
    "history_coverage",
    {
      description:
        "Placeholder only: broker historical-data coverage cannot be verified until real history retrieval is implemented. This tool does not inspect simulated demo candles or claim broker history is available.",
      inputSchema: {
        symbol: z
          .enum(SUPPORTED_SYMBOLS)
          .describe("The single supported instrument to inspect."),
        timeframe: z
          .enum(TIMEFRAMES)
          .describe("The timeframe whose broker history coverage is requested."),
      },
    },
    async ({ symbol, timeframe }) =>
      errorResult(
        `Historical coverage cannot be verified for ${symbol} on ${timeframe}. Broker history retrieval is not implemented; no coverage check was performed.`,
      ),
  );

  // 15. Quantitative equations: use caller-supplied data only
  server.registerTool(
    "run_quant_equations",
    {
      description:
        "Calculate descriptive statistics, simple returns, volatility, and maximum drawdown from supplied numeric observations. Does not fetch market data or generate trading signals. Supply chronologically ordered observations and ensure their meaning and frequency match the selected calculation.",
      inputSchema: {
        values: z
          .array(z.number())
          .min(1)
          .max(10000)
          .describe(
            "Numeric observations in chronological order, oldest first. Use appropriate price or equity values for return and drawdown calculations.",
          ),
        operation: z
          .enum(["statistics", "returns", "risk"])
          .optional()
          .describe(
            "Calculation to perform; defaults to descriptive statistics.",
          ),
        periodsPerYear: z
          .number()
          .finite()
          .min(1)
          .max(1000000)
          .optional()
          .describe(
            "Annualization periods for risk calculations. Defaults to 252; select a value appropriate for the observation frequency.",
          ),
      },
    },
    async ({ values, operation, periodsPerYear }) => {
      if (!finiteNumbers(values)) {
        return errorResult("All input values must be finite numbers.");
      }

      try {
        const selectedOperation = operation ?? "statistics";

        if (selectedOperation === "statistics") {
          return textResult({
            operation: selectedOperation,
            observationCount: values.length,
            stats: calculateStats(values),
            note:
              "Descriptive statistics only. Interpret results according to the units and meaning of the supplied observations.",
          });
        }

        if (selectedOperation === "returns") {
          return textResult({
            operation: selectedOperation,
            observationCount: values.length,
            simpleReturns: calculateReturns(values),
            note:
              "Returns are calculated from the supplied observations in their given order. Confirm that the observations are suitable for return calculations.",
          });
        }

        const returns = calculateReturns(values);
        const stats = calculateStats(returns);
        const annualizationPeriods = periodsPerYear ?? 252;
        const annualizationFactor = Math.sqrt(annualizationPeriods);

        return textResult({
          operation: selectedOperation,
          observationCount: values.length,
          returnCount: returns.length,
          meanPeriodReturn: stats.mean,
          periodVolatility: stats.populationStdDev,
          annualizedVolatility:
            stats.populationStdDev * annualizationFactor,
          maxDrawdown: calculateMaxDrawdown(values),
          assumptions: {
            returnType: "simple returns",
            volatility: "population standard deviation",
            annualizationPeriods,
            note:
              "Annualized volatility assumes the selected annualization periods are appropriate for the observation frequency. Maximum drawdown is calculated from the supplied series.",
          },
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Calculation failed.",
        );
      }
    },
  );
  
  // 16. Market summary: refuses to summarize fabricated prices as live
  server.registerTool(
    "get_market_summary",
    {
      description:
        "Check live market-data readiness for one supported symbol and optional timeframe. This tool does not fetch prices or perform technical analysis. Never interpret its response as a trading signal.",
      inputSchema: {
        symbol: z
          .enum(SUPPORTED_SYMBOLS)
          .describe("The single instrument to check."),
        timeframe: z
          .enum(TIMEFRAMES)
          .optional()
          .describe("Optional timeframe to check; defaults to H1."),
      },
    },
    async ({ symbol, timeframe }) =>
      textResult({
        symbol,
        timeframe: timeframe ?? "H1",
        source: "READINESS_CHECK",
        isLive: false,
        liveQuoteAvailable: false,
        liveCandlesAvailable: false,
        technicalAnalysisPerformed: false,
        summary:
          "Insufficient verified live market data for a market summary.",
        nextRequirement:
          "Integrate and verify a real market-data provider before calculating technical signals.",
      }),
  );
  
  // 17. Instrument comparison
  server.registerTool(
    "compare_instruments",
    {
      description:
        "Compare user-supplied numeric observations for exactly two instruments. Does not fetch market data. Supply only the observations needed for the comparison, and ensure both series are comparable before interpreting the results.",
      inputSchema: {
        instrumentA: z
          .string()
          .trim()
          .min(1)
          .describe("Name of the first instrument or data series."),
        valuesA: z
          .array(z.number())
          .min(1)
          .max(10000)
          .describe("Finite numeric observations for the first series."),
        instrumentB: z
          .string()
          .trim()
          .min(1)
          .describe("Name of the second instrument or data series."),
        valuesB: z
          .array(z.number())
          .min(1)
          .max(10000)
          .describe("Finite numeric observations for the second series."),
      },
    },
    async ({ instrumentA, valuesA, instrumentB, valuesB }) => {
      if (
        !finiteNumbers(valuesA) ||
        !finiteNumbers(valuesB)
      ) {
        return errorResult("All values must be finite numbers.");
      }

      try {
        return textResult({
          instrumentA: {
            name: instrumentA,
            observationCount: valuesA.length,
            statistics: calculateStats(valuesA),
          },
          instrumentB: {
            name: instrumentB,
            observationCount: valuesB.length,
            statistics: calculateStats(valuesB),
          },
          note:
            "This compares supplied numbers only; it does not fetch market data. Matching units, sampling frequencies, time periods, and data meanings must be verified before interpreting the comparison.",
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : "Comparison failed.",
        );
      }
    },
  );

  return server;
}

const apiHandler = {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const workerEnv = env as Env;

    // Build a fresh SDK v2 server for each request, with this request's
    // environment captured for provider calls.
    return createMcpHandler(() => createServer(workerEnv))(
      request,
      env,
      ctx,
    );
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
