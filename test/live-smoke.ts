/**
 * Read-only live smoke test. Requires real credentials in the environment:
 *   ZAMMAD_URL, ZAMMAD_TOKEN (or ZAMMAD_BEARER_TOKEN).
 *
 * It exercises a few read tools and the knowledge base search ladder without
 * touching any write endpoints. Run with: npm run smoke:live
 */
import { createZammadGateway } from '../src/gateway.js';

async function main(): Promise<void> {
  if (!process.env.ZAMMAD_URL || !(process.env.ZAMMAD_TOKEN || process.env.ZAMMAD_BEARER_TOKEN)) {
    throw new Error('Set ZAMMAD_URL and ZAMMAD_TOKEN (or ZAMMAD_BEARER_TOKEN) to run the live smoke test.');
  }

  const gateway = createZammadGateway();

  const reads: Array<[string, Record<string, string | number>]> = [
    ['list_groups', {}],
    ['list_ticket_states', {}],
    ['list_ticket_priorities', {}],
    ['kb_search', { query: 'password', limit: 3 }],
  ];

  for (const [tool, input] of reads) {
    const result = await gateway.callTool(tool, input);
    const summary = summarize(result.structuredContent);
    console.log(`ok  ${tool.padEnd(24)} -> ${summary}`);
  }
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (value && typeof value === 'object') {
    return `object{${Object.keys(value).slice(0, 6).join(',')}}`;
  }
  return String(value);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
