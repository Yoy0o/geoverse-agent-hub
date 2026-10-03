// 调用一个 MCP 工具并输出文本结果：node test/mcp-call.mjs <hub地址> <令牌> <工具> '<JSON 参数>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, token, name, json] = process.argv.slice(2);
const c = new Client({ name: "e2e-call", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp?agent=codex"), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
const r = await c.callTool({ name, arguments: JSON.parse(json || "{}") });
console.log(r.content.map((x) => x.text).join("\n"));
await c.close();
process.exit(r.isError ? 1 : 0);
