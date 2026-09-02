import { Injectable, Logger } from '@nestjs/common';

import {
  AiDispatchService,
  type AiUnavailableCause,
} from '../ai/ai-dispatch.service';
import type { AiStreamEvent, AiUsage } from '../ai/ai.types';
import { PrismaService } from '../prisma/prisma.service';
import { CivicsService } from './civics.service';
import type { CivicsExplainInput } from './dto/civics-explain.dto';
import { buildExplainPrompt } from './explain-prompt';

// =============================================================================
// CivicsExplainService (issue #120, epic #53 / E4)
// =============================================================================
//
// The tutor explanation behind `POST /api/civics/questions/:id/explain`: read
// the question and the answers that are correct for THIS learner, build the
// grounded prompt, and turn the dispatcher's stream into the frames the
// controller writes to the wire.
//
// -----------------------------------------------------------------------------
// THIS SERVICE PRODUCES FRAMES. THE CONTROLLER PRODUCES SSE.
// -----------------------------------------------------------------------------
//
// Everything below is `text/event-stream`-shaped and knows nothing about
// `text/event-stream`: no headers, no `data:` lines, no reply object. That
// split is what makes the interesting decisions testable without HTTP — every
// `unavailable` cause, the provider failure, the `state_required` refusal and
// the exactly-one-terminal-frame contract are all assertions over an async
// iterable in `civics-explain.service.spec.ts`. A service that wrote frames
// itself could only be tested through a socket, and the cases worth testing are
// exactly the ones a socket makes awkward.
//
// -----------------------------------------------------------------------------
// `explain` IS `async` AND RETURNS AN ITERABLE. IT IS NOT ITSELF A GENERATOR.
// -----------------------------------------------------------------------------
//
// The same shape `AiDispatchService.runStream` has, for the same reason. A
// generator's body does not run until the first `next()`, so an unknown
// question id would become a throw AFTER the controller had already sent
// `200 text/event-stream` — a 404 delivered as a broken stream instead of as a
// 404. Awaiting the lookup here means `NotFoundException` propagates while the
// response is still unwritten and `HttpExceptionFilter` can do its job.
//
// -----------------------------------------------------------------------------
// EXACTLY ONE TERMINAL FRAME, ALWAYS LAST
// -----------------------------------------------------------------------------
//
// `done`, `error`, `unavailable` and `state_required` are all terminal, and
// every path out of this service ends in exactly one of them followed by
// nothing. That is `AiStreamEvent`'s contract carried up to the wire, and it is
// what a client can rely on to stop waiting: a browser that never sees a
// terminal frame holds a connection open forever on a request that is over.
//
// -----------------------------------------------------------------------------
// NO USER ID AND NO STATE IS EVER AN INPUT
// -----------------------------------------------------------------------------
//
// `userId` comes from `@CurrentUser('id')`, and the state is read from that
// user's own `learner_profiles` row through `CivicsService.getQuestion` — the
// same resolution the read route uses, not a second copy of civics-content.md
// §5's table. Nothing here takes a state code, and there is no method to add
// one to without changing a signature in a visible diff.
// =============================================================================

/**
 * One frame on the way to the client, named by the SSE event it becomes.
 *
 * A DISCRIMINATED UNION RATHER THAN `{ event: string; data: unknown }`, for the
 * reason `AiStreamEvent` gives: the terminal frames have no `text` to read, so
 * a consumer that appends `data.text` on every frame fails to compile instead
 * of appending `undefined` to a learner's explanation.
 */
export type CivicsExplainFrame =
  /** A chunk of the explanation. Never empty. */
  | { event: 'delta'; data: { text: string } }
  /** Terminal. The explanation is whole; `usage` is what the provider reported. */
  | { event: 'done'; data: { usage: AiUsage } }
  /**
   * Terminal. No call was attempted, and why — an administrator's unfinished
   * configuration, or the caller's own missing key. NOT a failure: nothing was
   * spent and nothing is broken. See `ai-evaluation.md` §4.
   */
  | { event: 'unavailable'; data: { cause: AiUnavailableCause } }
  /**
   * Terminal. A `state`-scope question asked by a learner with no state set.
   *
   * -------------------------------------------------------------------------
   * WHY THIS IS ITS OWN EVENT AND NOT A FIFTH `unavailable` CAUSE
   * -------------------------------------------------------------------------
   *
   * Two reasons, and both are about what the client does next.
   *
   * It is not an AI fact. The other four causes say "AI is not set up for you
   * or for this deployment" and are answered by an admin finishing
   * configuration or by the learner storing a key. This one says "we do not
   * know which state's governor to explain", and it is answered by the learner
   * setting their state — a different screen, a different sentence, and a
   * remedy that has nothing to do with AI being available. Rendering the
   * shared unavailable component here would send a learner to check an API key
   * over a profile field.
   *
   * And `AiUnavailableCause` is a CLOSED set of four (`ai-evaluation.md` §4,
   * §12) that every consumer branches on exhaustively. Adding a member for a
   * fact that is not about AI would force a re-audit of every one of those
   * branches, in the dispatcher, in the status endpoint and on the web.
   *
   * The payload deliberately echoes `answerResolution: 'state_required'`, the
   * discriminator `GET /api/civics/questions/{id}` already returns for the same
   * learner and the same question — so the client renders the prompt it already
   * has rather than learning a second vocabulary for one fact.
   *
   * civics-content.md §5 is why no model is called: guessing a state would hand
   * the learner a specific, memorable, confidently-explained WRONG governor,
   * which is worse than an honest "we don't know yet".
   */
  | { event: 'state_required'; data: { answerResolution: 'state_required' } }
  /**
   * Terminal. The call was attempted and did not produce a usable answer.
   *
   * The deltas already delivered stand — they were really received — but the
   * explanation is not whole and must not be presented as one.
   */
  | { event: 'error'; data: { errorCode: string; error: string } };

/**
 * The role this feature spends the learner's key on.
 *
 * `tutor`, and named as a constant because it is a REGISTRY KEY
 * (`ai/ai-model-roles.ts`) that is persisted on every `ai_usage_events` row —
 * an admin reading last month's usage has to be able to tell tutor spend from
 * grader spend. The dispatcher resolves which model that is; this service
 * cannot name one, which is the point of the door (`ai-evaluation.md` §3).
 */
const TUTOR_ROLE = 'tutor' as const;

/**
 * The generation cap for one explanation.
 *
 * A COST CEILING, NOT THE SHAPE OF THE ANSWER. The prompt asks for a short
 * paragraph or two, so a well-behaved model finishes well inside this; the cap
 * is what bounds the bill when one does not. It is set generously for that
 * reason — a cap tight enough to be reached regularly would truncate
 * explanations mid-sentence and still report `done`, because a length stop is
 * a normal completion as far as the provider is concerned.
 */
const EXPLAIN_MAX_TOKENS = 700;

@Injectable()
export class CivicsExplainService {
  private readonly logger = new Logger(CivicsExplainService.name);

  constructor(
    // The SAME resolution the read route uses. Not a copy of §5's table, and
    // not a second query: `getQuestion` already narrows by the question's
    // `dynamicScope` and the caller's own state, applies the clock, and reports
    // `state_required` when there is no state to resolve for. Reimplementing
    // any of that here would be a second place the rule lives, and the drift
    // would present as a tutor explaining an answer the read route does not
    // show.
    private readonly civics: CivicsService,
    // Read for exactly one column: `explanation_language`. See
    // {@link readExplanationLanguage}.
    private readonly prisma: PrismaService,
    // The one door (`ai-evaluation.md` §3). No provider, no model id, no key
    // is reachable from this file.
    private readonly dispatch: AiDispatchService,
  ) {}

  /**
   * Open an explanation stream for one question.
   *
   * NEVER THROWS FOR AN AI REASON, and the iterator it returns never throws at
   * all. The one exception it does propagate is `NotFoundException` for an
   * unknown question id — deliberately, and before any byte of the response is
   * written, so an unknown id is an ordinary 404 rather than a stream that
   * opens and immediately breaks.
   *
   * @param signal aborts the upstream call when the client goes away. Passed
   *        straight through to the dispatcher: this service does not watch the
   *        socket (the controller owns the transport) and does not need to —
   *        it forwards the signal and stops iterating.
   */
  async explain(
    userId: string,
    questionId: string,
    input: CivicsExplainInput,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<CivicsExplainFrame>> {
    // May throw NotFoundException — see the doc comment. Awaited here, outside
    // the generator, which is what makes that a 404 instead of a broken stream.
    const question = await this.civics.getQuestion(userId, questionId);

    if (question.answerResolution === 'state_required') {
      // NO MODEL CALL AT ALL. Not a call with an empty answer list, not a call
      // with another state's answer: there is nothing correct to explain, and
      // the only thing a tutor could do with the question alone is invent
      // one. civics-content.md §5.
      this.logger.debug(
        `Explain refused for question ${questionId}: state-scoped, caller has no state`,
      );

      return once({
        event: 'state_required',
        data: { answerResolution: 'state_required' },
      });
    }

    const messages = buildExplainPrompt({
      questionPrompt: question.prompt,
      // The resolved answers, as text, in slot order — exactly what the read
      // route would have shown this same learner for this same question.
      answers: question.answers.map((answer) => answer.text),
      explanationLanguage: await this.readExplanationLanguage(userId),
      focus: input.focus,
    });

    const run = await this.dispatch.runStream(
      userId,
      TUTOR_ROLE,
      { messages, maxTokens: EXPLAIN_MAX_TOKENS },
      signal,
    );

    if (run.status === 'unavailable') {
      // A VALUE, RENDERED AS A FRAME — not a 5xx and not a connection left
      // open. The stream opens and immediately says why nothing is coming, so
      // the client draws the shared "AI is not set up" component instead of
      // spinning on a response that will never produce a token (#120).
      return once({ event: 'unavailable', data: { cause: run.cause } });
    }

    return toFrames(run.events);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The caller's own `explanation_language`, or `null` when they have no
   * profile row yet.
   *
   * READ HERE RATHER THAN THREADED THROUGH `CivicsService`. That service's
   * profile read is deliberately narrow — the two columns answer resolution
   * needs — and widening it would put a column no read route uses into the one
   * query every civics read makes. One extra indexed lookup on the caller's own
   * row is the cheaper mistake.
   *
   * A MISSING ROW IS NOT AN ERROR. A learner whose profile has not been created
   * yet has no stated language, which is the same fact as a blank column, and
   * `buildExplainPrompt` turns both into `en`. Creating a row here would make a
   * read-shaped request a write, which is the thing `CivicsService`'s header
   * says this module does not do.
   */
  private async readExplanationLanguage(userId: string): Promise<string | null> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: { explanationLanguage: true },
    });

    return profile?.explanationLanguage ?? null;
  }
}

// -----------------------------------------------------------------------------
// Stream plumbing
// -----------------------------------------------------------------------------

/**
 * A stream of exactly one terminal frame.
 *
 * The shape every "nothing will be generated" path returns, so the controller
 * has ONE loop and no special case: an `unavailable` and a full explanation are
 * both "iterate until the terminal frame". A second return shape would be a
 * second code path on the transport side, and the second one is the one that
 * gets written badly — the same argument `AiStreamRunResult` makes for having
 * no `failed` variant.
 */
async function* once(
  frame: CivicsExplainFrame,
): AsyncGenerator<CivicsExplainFrame, void, undefined> {
  yield frame;
}

/**
 * `AiStreamEvent` -> wire frames.
 *
 * A one-to-one mapping with no buffering and no re-chunking: a delta is
 * forwarded the moment it arrives, because "appears word by word" is the entire
 * product argument for streaming an explanation (#120). Collecting deltas to
 * tidy them into sentences would deliver the same paragraph after the same wait
 * as a non-streamed call, with more code.
 *
 * `usageEventId` IS DROPPED. It is the `ai_usage_events` row id — a server-side
 * accounting handle for callers that store a foreign key to it, and this one
 * does not (an explanation is not stored at all). Publishing an internal row id
 * to a browser to satisfy the type would be a wider response than the feature
 * needs.
 *
 * A `return()` on this generator — the controller breaking out of its loop when
 * the client disconnects — propagates into the `for await` below and closes
 * `events`, which is what runs `BaseAiProvider.stream`'s `finally` and records
 * the usage row for an abandoned stream. That propagation is the mechanism, not
 * a side effect: writing this as a manual `while (true)` over `next()` without
 * forwarding `return()` would leave the upstream generator suspended forever
 * and the row unwritten.
 */
async function* toFrames(
  events: AsyncIterable<AiStreamEvent>,
): AsyncGenerator<CivicsExplainFrame, void, undefined> {
  for await (const event of events) {
    switch (event.type) {
      case 'delta':
        yield { event: 'delta', data: { text: event.text } };
        break;

      case 'done':
        yield { event: 'done', data: { usage: event.usage } };
        break;

      case 'error':
        // The dispatcher's own resolution failures arrive here too, as a
        // one-event stream — which is why this file has no second failure
        // path to keep in step (`AiDispatchService.runStream`).
        yield {
          event: 'error',
          data: { errorCode: event.errorCode, error: event.error },
        };
        break;
    }
  }
}
