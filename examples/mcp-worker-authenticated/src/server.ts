import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { AuthHandler } from "./auth-handler";

function createServer() {
  const server = new McpServer({
    name: "Authenticated MCP Server",
    version: "1.0.0"
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting message",
      inputSchema: { name: z.string().optional() }
    },
    async ({ name }) => {
      const auth = getMcpAuthContext();
      const username = auth?.props?.username as string | undefined;

      return {
        content: [
          {
            text: `Hello, ${name ?? username ?? "World"}!`,
            type: "text"
          }
        ]
      };
    }
  );

  server.registerTool(
    "whoami",
    {
      description: "Returns information about the authenticated user"
    },
    async (context) => {
      const auth = getMcpAuthContext();

      if (!auth) {
        return {
          content: [
            {
              text: "No authentication context available",
              type: "text"
            }
          ]
        };
      }

      return {
        content: [
          {
            text: JSON.stringify(
              {
                userId: auth.props?.userId,
                username: auth.props?.username,
                email: auth.props?.email,
                clientId: context.http?.authInfo?.clientId,
                scopes: context.http?.authInfo?.scopes
              },
              null,
              2
            ),
            type: "text"
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_data_status",
    {
      description:
        "Reports the current integration status of the read-only trading data providers."
    },
    async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                server: "online",
                authentication: "OAuth enabled",
                providers: {
                  metaapi: "not integrated",
                  finnhub: "not integrated"
                },
                trading: "read-only; no order execution tools"
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "get_market_quote",
    {
      description:
        "Returns simulated market quote data for testing only. These are NOT live prices, market analysis, or trading signals.",
      inputSchema: {
        symbol: z
          .string()
          .regex(/^[A-Z0-9._-]{3,20}$/i)
          .describe("Instrument symbol, e.g. EURUSD, GBPUSD, or XAUUSD"),
      },
    },
    async ({ symbol }) => {
      const normalizedSymbol = symbol.toUpperCase();

      const mockQuotes: Record<
        string,
        { bid: number; ask: number }
      > = {
        EURUSD: { bid: 1.0001, ask: 1.0003 },
        GBPUSD: { bid: 1.0002, ask: 1.0005 },
        XAUUSD: { bid: 100.1, ask: 100.6 },
      };

      const quote = mockQuotes[normalizedSymbol];

      const result = quote
        ? {
            symbol: normalizedSymbol,
            bid: quote.bid,
            ask: quote.ask,
            spread: Number((quote.ask - quote.bid).toFixed(5)),
            response_timestamp: new Date().toISOString(),
            data_source: "mock",
            is_simulated: true,
            warning:
              "SIMULATED TEST DATA — NOT LIVE MARKET PRICES. Do not use for trading decisions.",
          }
        : {
            error: "No simulated quote is configured for this symbol.",
            symbol: normalizedSymbol,
            available_mock_symbols: Object.keys(mockQuotes),
            data_source: "mock",
            is_simulated: true,
          };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_market_candles",
    {
      description:
        "Returns simulated OHLC candles for testing only. These are artificial values, NOT historical or live market data. Never use them for trading decisions.",
      inputSchema: {
        symbol: z
          .string()
          .regex(/^[A-Z0-9._-]{3,20}$/i)
          .describe("Instrument symbol, e.g. EURUSD, GBPUSD, or XAUUSD"),
        timeframe: z
          .enum(["M15", "H1", "H4", "D1", "W1"])
          .describe("Candle timeframe: M15, H1, H4, D1, or W1"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Number of simulated candles to return, from 1 to 10"),
      },
    },
    async ({ symbol, timeframe, limit }) => {
      const normalizedSymbol = symbol.toUpperCase();

      const supportedSymbols = ["EURUSD", "GBPUSD", "XAUUSD"];

      if (!supportedSymbols.includes(normalizedSymbol)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "No simulated candles configured for this symbol.",
                  symbol: normalizedSymbol,
                  available_mock_symbols: supportedSymbols,
                  data_source: "mock",
                  is_simulated: true,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const intervalMs: Record<string, number> = {
        M15: 15 * 60 * 1000,
        H1: 60 * 60 * 1000,
        H4: 4 * 60 * 60 * 1000,
        D1: 24 * 60 * 60 * 1000,
        W1: 7 * 24 * 60 * 60 * 1000,
      };

      // Fixed artificial base values; these are not real market prices.
      const basePrices: Record<string, number> = {
        EURUSD: 1.05,
        GBPUSD: 1.25,
        XAUUSD: 2500,
      };

      const base = basePrices[normalizedSymbol];
      const candleDuration = intervalMs[timeframe];
      const now = Date.now();

      const candles = Array.from({ length: limit }, (_, index) => {
        const step = limit - index;
        const close = Number(
          (base + Math.sin(step * 1.7) * base * 0.001).toFixed(5)
        );
        const open = Number(
          (base + Math.cos(step * 1.3) * base * 0.001).toFixed(5)
        );
        const high = Number(
          (Math.max(open, close) + base * 0.0005).toFixed(5)
        );
        const low = Number(
          (Math.min(open, close) - base * 0.0005).toFixed(5)
        );

        return {
          timestamp: new Date(
            now - step * candleDuration
          ).toISOString(),
          open,
          high,
          low,
          close,
          volume: null,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                symbol: normalizedSymbol,
                timeframe,
                candle_count: candles.length,
                candles,
                data_source: "mock",
                is_simulated: true,
                warning:
                  "SIMULATED TEST DATA — NOT REAL HISTORICAL OR LIVE PRICES. Timestamps are generated for testing; candles and prices do not represent actual market history.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

const apiHandler = {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return mcpHandler(request, env, ctx);
  },
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  apiRoute: "/mcp",
  apiHandler: apiHandler,

  defaultHandler: {
    async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
      return AuthHandler.fetch(request, env as Record<string, unknown>, ctx);
    }
  }
});
