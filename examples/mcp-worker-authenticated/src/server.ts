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
