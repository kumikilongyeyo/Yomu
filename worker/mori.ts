/**
 * Mori's voice — the one part of the companion that actually thinks.
 *
 * Everything else Mori says comes out of a fixed corpus. This is a real model
 * call, and that makes it the only piece of Yomu that costs money per use and
 * the only public endpoint that can be made expensive by a stranger. Most of
 * what follows is about that rather than about the conversation.
 *
 * Three guards, in order of how much they matter:
 *
 *   1. No key, no endpoint. `ANTHROPIC_API_KEY` is a Worker secret and is
 *      never in the repo. Unset, `/api/mori/chat` answers 503 with
 *      `configured:false` and the client hides the chat entirely, so the
 *      feature is off by default rather than half-on.
 *   2. A daily spend ceiling, counted in KV. Per-IP throttling stops one
 *      person hammering it; only a global counter stops a thousand people
 *      doing it once each. This is the number that bounds the bill.
 *   3. A small, bounded request. Short history, a cap on message length, low
 *      effort, modest max_tokens.
 *
 * What Mori is allowed to do is deliberately narrow. It answers questions
 * about reading and recommends things, using one tool backed by Yomu's own
 * catalogue -- so a recommendation is a title Yomu can actually open, not a
 * title the model remembered.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './index';
import { handleSimilar } from './similar';

/* The model is a constant and not a request parameter on purpose: the caller
   is a public web page, and letting it name a model lets it name an
   expensive one. Change it here. */
const MODEL = 'claude-opus-5';

/** Bounds, all of them deliberate. */
const MAX_MESSAGE_CHARS = 600;
const MAX_HISTORY_TURNS = 8;
const MAX_TOKENS = 1024;
/** The ceiling on what a day can cost, across everybody. */
const REPLIES_PER_DAY = 300;
const REPLIES_PER_IP_PER_HOUR = 20;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** What the client tells us about the reader. Untrusted; used only as flavour. */
interface MoriContext {
  name?: string;
  chaptersRead?: number;
  topGenres?: string[];
  library?: string[];
  reading?: string;
}

const SYSTEM = `You are Mori, the reading companion inside Yomu, a manga and manhwa reader.

Who you are: warm, brief, and a little dry. You live in a small speech bubble, so you write like someone talking, not like documentation. Two or three sentences is normal. Never use bullet points, headings or markdown.

What you do: talk about what the reader is reading, help them decide what to read next, and answer questions about series, genres and tropes.

Recommending: call find_similar and recommend from what it returns. Each pick carries a vote count -- how many readers of that series suggested it -- so prefer the ones with real weight behind them, and you may say so ("a lot of Solo Leveling readers go to this next"). Never quote the raw number as a statistic. Do not recommend a title from memory -- if it is not in Yomu, the reader cannot open it, and a name they cannot tap is worse than no answer. If the tool gives you nothing useful, say so plainly and ask what they are in the mood for.

Naming: when you recommend something, name it once and say in a few words why it fits what they already read. No synopses.

What you are not: you are not a general assistant. If the reader asks for something unrelated to reading -- code, homework, personal advice, anything sensitive -- say that is not what you are for and steer back to books. Never claim to have read something. Never invent a chapter count, a rating or a release date.

Spoilers: never reveal plot beyond what a back-cover blurb would say, whatever they ask.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_similar',
    description:
      "Find series in Yomu's catalogue similar to a title the reader knows, or that match a theme. "
      + 'Returns real titles readers of that series voted for, each with a vote count, plus the tags the match was made on. '
      + 'Call this before recommending anything.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A series title to find things like. Use one the reader has mentioned or read.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    /* Guarantees the arguments validate, so the handler below never has to
       defend against a malformed input object. */
    strict: true,
  },
];

/**
 * The tool, answered by the recommendation engine rather than the model's
 * memory.
 *
 * Goes through the same cached route the menu uses, so a model call and a tap
 * on "What should I read?" cannot disagree, and the second of them is free.
 * The vote counts are handed to the model deliberately: "1,387 readers" is
 * the difference between a recommendation it can stand behind and a list.
 */
async function findSimilar(title: string, env: Env, origin: string): Promise<string> {
  try {
    const url = new URL(`${origin}/api/catalog/similar?title=${encodeURIComponent(title)}`);
    const response = await handleSimilar(new Request(url.toString()), env, url);
    const answer: any = await response.json();
    if (!answer?.picks?.length) {
      return JSON.stringify({ found: 0, note: 'Nothing in the catalogue matched that title.' });
    }
    return JSON.stringify({
      matched: answer.matched ?? title,
      tags: (answer.tags ?? []).slice(0, 6),
      picks: answer.picks.slice(0, 8),
    });
  } catch (error: any) {
    /* An error is returned to the model as a result, not thrown: the
       conversation should carry on and say the shelf was unreachable. */
    return JSON.stringify({ error: String(error?.message ?? 'Catalogue lookup failed.') });
  }
}

/* --- limits -------------------------------------------------------------- */

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Two counters. The per-IP one stops one person hammering it; the global one
 * is the actual cost ceiling and the reason this endpoint cannot run up a
 * bill overnight.
 *
 * Both are KV writes, and KV's free tier allows a thousand a day -- shared
 * with Sync. That is the real reason REPLIES_PER_DAY is 300 rather than
 * 30,000: two writes a reply, and the budget is not ours alone.
 */
async function overBudget(env: Env, request: Request): Promise<string | null> {
  const day = `mori:day:${today()}`;
  const spent = Number((await env.SYNC.get(day)) ?? '0');
  if (spent >= REPLIES_PER_DAY) {
    return 'Mori has done a lot of talking today. Try again tomorrow.';
  }

  const who = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const hour = `mori:ip:${who}:${Math.floor(Date.now() / 3600000)}`;
  const mine = Number((await env.SYNC.get(hour)) ?? '0');
  if (mine >= REPLIES_PER_IP_PER_HOUR) {
    return 'That is a lot of questions at once. Give me an hour.';
  }

  await env.SYNC.put(day, String(spent + 1), { expirationTtl: 172800 });
  await env.SYNC.put(hour, String(mine + 1), { expirationTtl: 7200 });
  return null;
}

/* --- the route ----------------------------------------------------------- */

export async function handleMori(request: Request, env: Env, url: URL): Promise<Response> {
  /* Whether the feature exists at all. The client asks this before it draws a
     chat affordance, so an unconfigured deployment shows no dead button. */
  if (url.pathname === '/api/mori/status') {
    return json({ configured: !!env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_API_KEY ? MODEL : null });
  }

  if (url.pathname !== '/api/mori/chat') return json({ error: 'No such route.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Only POST is supported.' }, 405);

  if (!env.ANTHROPIC_API_KEY) {
    return json(
      { configured: false, error: 'Mori cannot talk yet: no API key is set on this deployment.' },
      503,
    );
  }

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Bad request body.' }, 400); }

  const message = String(body?.message ?? '').trim();
  if (!message) return json({ error: 'Say something.' }, 400);
  if (message.length > MAX_MESSAGE_CHARS) {
    return json({ error: `Keep it under ${MAX_MESSAGE_CHARS} characters.` }, 400);
  }

  const blocked = await overBudget(env, request);
  if (blocked) return json({ error: blocked, throttled: true }, 429);

  /* History is the client's, so it is rebuilt rather than trusted: only the
     two roles, only strings, only the last few turns. */
  const history: ChatTurn[] = Array.isArray(body?.history)
    ? body.history
        .filter((t: any) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
        .slice(-MAX_HISTORY_TURNS)
        .map((t: any) => ({ role: t.role, content: String(t.content).slice(0, MAX_MESSAGE_CHARS) }))
    : [];

  const context: MoriContext = body?.context && typeof body.context === 'object' ? body.context : {};
  const about = [
    context.name ? `Their name is ${String(context.name).slice(0, 40)}.` : '',
    typeof context.chaptersRead === 'number' ? `They have finished ${context.chaptersRead} chapters in Yomu.` : '',
    context.topGenres?.length ? `They mostly read: ${context.topGenres.slice(0, 5).join(', ')}.` : '',
    context.library?.length ? `In their library: ${context.library.slice(0, 12).join('; ')}.` : '',
    context.reading ? `Right now they are reading ${context.reading}.` : '',
  ].filter(Boolean).join(' ');

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: message },
  ];

  try {
    /* A short manual loop rather than the tool runner: one tool, at most two
       rounds, and the runner is beta. `find_similar` is the only thing that
       can be called, so the loop cannot wander. */
    let reply = '';
    for (let round = 0; round < 3; round++) {
      const response: Anthropic.Message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        /* Low effort: this is a two-sentence answer in a speech bubble, and
           the reader is watching a pet wait. Thinking stays on -- disabling
           it on Opus 5 can leak a tool call into visible text. */
        output_config: { effort: 'low' },
        system: [
          { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
          ...(about ? [{ type: 'text' as const, text: `About this reader: ${about}` }] : []),
        ],
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === 'refusal') {
        return json({ reply: 'I would rather not answer that one. Ask me about something to read?' });
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (!toolUses.length) {
        reply = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        break;
      }

      messages.push({ role: 'assistant', content: response.content });

      /* Every tool_result goes back in one user message. Splitting them
         teaches the model to stop calling tools in parallel. */
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const input = use.input as { title?: string };
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: await findSimilar(String(input?.title ?? ''), env, url.origin),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    if (!reply) reply = 'I lost my thread there. Ask me again?';
    return json({ reply });
  } catch (error: any) {
    /* The key, the model id and the upstream body never reach the client --
       this endpoint is public. The status is enough for the caller to know
       whether waiting will help. */
    const status = Number(error?.status) || 0;
    console.error('[mori] chat failed', status, error?.message);
    if (status === 429) return json({ error: 'Mori is busy. Try again in a moment.', throttled: true }, 429);
    if (status === 401 || status === 403) return json({ error: 'Mori cannot talk right now.' }, 503);
    return json({ error: 'Mori could not answer just now.' }, 502);
  }
}
