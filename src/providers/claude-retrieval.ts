/**
 * BM25 retrieval served TO a Claude session, over loopback MCP.
 *
 * The prompt path already narrows evidence *before* a call (`retrieve.ts`,
 * `retriever.ts`): rank, cut, disclose. What it cannot do is answer a question
 * the model only discovers mid-thought — an authoring model that realises it
 * needs the overtime table's columns, a healer that wants to know whether a
 * route exists behind the label it is looking at. This module is the other
 * direction: the same BM25, the same corpus (the repository context graph and
 * the run's context documents), exposed as ONE tool the claude-cli generator
 * and healer sessions may call.
 *
 * Three decisions, all inherited rather than invented:
 *
 *   * **Loopback HTTP, in-process.** A stdio MCP server would be a second
 *     Node boot per session — exactly the startup cost the warm-session work
 *     removed. This server lives inside the wowlidator process that already
 *     holds the corpus, binds 127.0.0.1 on an ephemeral port, and dies with
 *     the process. `server.unref()` so it never holds a run open.
 *   * **The corpus is registered, never discovered.** The commands that load
 *     context documents and the repo graph call `setClaudeRetrievalCorpus`
 *     with what they loaded; the tool searches exactly that. A server that
 *     walked the filesystem itself would re-answer "what is this run's
 *     evidence" differently from the prompt path — two sources of truth.
 *   * **An empty corpus attaches no tool.** `claude-cli.ts` checks
 *     `claudeRetrievalCorpusSize()` before adding `--mcp-config`; a run with
 *     nothing registered runs byte-for-byte the vector it always ran.
 *
 * The retrieval rules carry over from `retriever.ts`: deterministic ranking
 * (ties break earlier-in-the-corpus), and every answer discloses that absence
 * from the results proves nothing about the corpus.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { chunkDocument } from '../catalog/retrieve.js';
import { Bm25Retriever, type RetrievalItem } from '../context/retriever.js';
import type { ExtractedDocument } from '../catalog/extract.js';
import type { ProjectGraph } from '../context/types.js';

export const RETRIEVAL_SERVER_NAME = 'wow-context';
export const RETRIEVAL_TOOL = 'search_context';
/** The name the claude CLI knows the tool by — what `--allowed-tools` must say. */
export const RETRIEVAL_TOOL_FULL = `mcp__${RETRIEVAL_SERVER_NAME}__${RETRIEVAL_TOOL}`;
/**
 * Hits per search and characters per hit. Measured 2026-09-05 (opus, 407
 * authoring asks): the tool was called in 95% of asks, ~2 times each, and
 * one answer of 8 × 1,600 Thai characters weighed about as much as the
 * whole row's prompt — each search cost ≈ +6k cache-write, +20-30k
 * cache-read tokens and 10-15 s. Half the hits at half the length keeps
 * the answer to the question asked; a caller that wants more says so.
 */
export const RETRIEVAL_DEFAULT_LIMIT = 4;
export const RETRIEVAL_MAX_LIMIT = 20;
/** A hit longer than this is cut — the tool answers questions, it does not re-send documents. */
export const RETRIEVAL_HIT_MAX_CHARS = 800;

const retriever = new Bm25Retriever();
let corpus: RetrievalItem[] = [];

/**
 * Replace the corpus with what a command actually loaded: context documents
 * (chunked the same way the prompt path chunks them, so the two retrievals
 * cannot disagree about what a "section" is) and the repository context graph
 * (one line per node — route, operation, table, component, test).
 */
export function setClaudeRetrievalCorpus(input: {
  docs?: readonly ExtractedDocument[] | undefined;
  graph?: ProjectGraph | null | undefined;
}): void {
  const next: RetrievalItem[] = [];
  for (const doc of input.docs ?? []) {
    for (const chunk of chunkDocument(doc)) {
      const where = chunk.headingPath === '' ? doc.name : `${doc.name} › ${chunk.headingPath}`;
      next.push({ id: where, text: chunk.text });
    }
  }
  for (const node of input.graph?.nodes ?? []) {
    const meta =
      node.meta === undefined
        ? ''
        : ' ' +
          Object.entries(node.meta)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
    next.push({
      id: node.id,
      text: `${node.kind} ${node.name} — ${node.file}${node.detail === undefined ? '' : ` — ${node.detail}`}${meta}`,
    });
  }
  corpus = next;
}

/** How many items a session could search right now. Zero means: attach no tool. */
export function claudeRetrievalCorpusSize(): number {
  return corpus.length;
}

/**
 * The tool's whole behaviour, separated from the transport so it can be unit
 * tested without a socket. Deterministic for identical inputs.
 */
export async function searchCorpus(query: string, limit?: number): Promise<string> {
  const capped = Math.min(Math.max(1, Math.trunc(limit ?? RETRIEVAL_DEFAULT_LIMIT)), RETRIEVAL_MAX_LIMIT);
  const ranked = await retriever.rank(query, corpus, capped);
  const hits = ranked.filter((item) => item.score > 0);
  if (hits.length === 0) {
    return (
      'No match in the indexed repository or context documents for that query. ' +
      'Absence here proves nothing — the corpus is an index, not the application. ' +
      'Try different words from the task itself.'
    );
  }
  const body = hits
    .map((hit, index) => {
      const text =
        hit.text.length > RETRIEVAL_HIT_MAX_CHARS
          ? `${hit.text.slice(0, RETRIEVAL_HIT_MAX_CHARS)}\n[cut at ${RETRIEVAL_HIT_MAX_CHARS} chars]`
          : hit.text;
      return `[${index + 1}] ${hit.id}\n${text}`;
    })
    .join('\n\n');
  return (
    `${body}\n\n[${hits.length} closest matches of ${corpus.length} indexed items shown. ` +
    'Never conclude something is absent from the application because it is absent here.]'
  );
}

function buildMcp(): McpServer {
  const mcp = new McpServer({ name: RETRIEVAL_SERVER_NAME, version: '1.0.0' });
  mcp.tool(
    RETRIEVAL_TOOL,
    'Search the target application\'s indexed repository (routes, API operations, database tables, ' +
      'components, existing tests) and this run\'s context documents. Lexical BM25 ranking: use the ' +
      'words the application itself would use. Returns the closest matching items with their sources; ' +
      'absence from the results never proves absence from the application.',
    {
      query: z.string().describe('What to look for, in the vocabulary of the task or the page.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(RETRIEVAL_MAX_LIMIT)
        .optional()
        .describe(`How many items to return (default ${RETRIEVAL_DEFAULT_LIMIT}).`),
    },
    async ({ query, limit }) => ({
      content: [{ type: 'text' as const, text: await searchCorpus(query, limit) }],
    }),
  );
  return mcp;
}

/** Stateless: one transport per request, nothing kept between calls. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.url === undefined || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const mcp = buildMcp();
    // No `sessionIdGenerator` key at all — that is the SDK's stateless mode,
    // and under `exactOptionalPropertyTypes` an explicit `undefined` is
    // refused by its own types.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    // The cast bridges the SDK's `onclose?: () => void` (its Transport
    // interface) against its own class's `onclose: (() => void) | undefined`
    // — an inconsistency in the SDK, not a shape difference.
    await mcp.connect(transport as Parameters<McpServer['connect']>[0]);
    await transport.handleRequest(req, res);
  } catch (error) {
    // A retrieval failure must never wedge the asking session — answer badly
    // rather than not at all, and say so where a person can read it.
    process.stderr.write(
      `wow-context retrieval request failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
}

let httpServer: Server | null = null;
let starting: Promise<string | null> | null = null;

/**
 * Start (once) and return the loopback MCP URL, or null when the server could
 * not start — the caller then simply attaches no tool, the same "an
 * optimisation must never be a new failure mode" contract as the warm session.
 */
export function ensureClaudeRetrievalServer(): Promise<string | null> {
  starting ??= (async () => {
    try {
      const server = createServer((req, res) => void handle(req, res));
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', () => resolveListen());
      });
      // A run must end when its work ends, not when this socket does.
      server.unref();
      httpServer = server;
      const address = server.address();
      if (address === null || typeof address === 'string') return null;
      return `http://127.0.0.1:${address.port}/mcp`;
    } catch (error) {
      process.stderr.write(
        `wow-context retrieval server could not start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return null;
    }
  })();
  return starting;
}

/** Close the server and forget the corpus. Safe to call twice; a test seam. */
export function closeClaudeRetrievalServer(): void {
  httpServer?.close();
  httpServer = null;
  starting = null;
  corpus = [];
}
