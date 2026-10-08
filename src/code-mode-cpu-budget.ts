import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodeModeToolResult, CodeModeTransport } from '@mastra/core/tools';
import type { QuickJsCodeModeTransport } from '@mastra/quickjs';
import type {
  InterruptHandler,
  QuickJSRuntime,
  QuickJSWASMModule,
  RuntimeOptions,
} from 'quickjs-emscripten';

/**
 * A Code Mode transport that stops a program the moment it computes for longer
 * than a short CPU budget without handing control back to the host.
 *
 * WHY. `@mastra/quickjs` runs every `execute_typescript` program in an
 * in-process QuickJS interpreter, ON THE NODE EVENT LOOP, and its only
 * interrupt is the wall-clock deadline (`CODE_MODE_TIMEOUT_MS`, 30s). So a
 * program that never awaits — `while (true) {}`, a runaway sort,
 * `for (;;) await null` — holds the event loop for the whole 30s, and every
 * other request the process serves waits behind it.
 *
 * WHAT IS BUDGETED. One SLICE is a stretch of guest execution between two
 * returns to the host; only awaiting an `external_*` call ends one. A slice
 * longer than `cpuBudgetMs` interrupts the program and ends it with
 * `CPU_BUDGET_EXCEEDED`. Time spent AWAITING an `external_*` call is never
 * counted: a program may await operations for the full 30s. A second, TOTAL cap
 * (`totalCpuBudgetMs`) sums the compute of every slice, so a program cannot dodge
 * the per-slice budget by looping compute -> await -> compute until the deadline
 * and stalling the event loop in budget-sized chunks.
 *
 * HOW, THROUGH THE PUBLIC API. The transport's `module` option takes the
 * QuickJS WASM module each program's runtime is created from. This hands it a
 * module whose `newRuntime()` installs the budget as the runtime's interrupt
 * handler, with the transport's own handler (deadline + caller abort) composed
 * behind it. QuickJS polls the handler every ~10k bytecode operations, so the
 * check runs INSIDE a busy loop. A slice starts at the first poll and ends when
 * the host's call stack unwinds — exactly when a queued microtask gets to run.
 * On the first overrun the guest is interrupted (uncatchable: no `catch` or
 * `finally` of the program runs) AND the run is aborted, so the result comes
 * back at once instead of waiting on guest promises the interrupt left
 * unsettled.
 *
 * NO RUNTIME IMPORT of `@mastra/quickjs` or `quickjs-emscripten` here: both
 * are OPTIONAL peers of this package, so `./code-mode.ts` loads them on the
 * first `execute_typescript` call and hands them in.
 *
 * PINNED INTERNALS. Two facts about `@mastra/quickjs` 0.1.1 are relied on, and
 * `__tests__/code-mode-cpu-budget.test.ts` fails loudly if either stops
 * holding: every runtime is created through the `module` option's
 * `newRuntime()` inside `run()`, and the transport installs its deadline
 * through `runtime.setInterruptHandler`. The test also pins the exact versions
 * — re-prove the budget before bumping either.
 *
 * Ported from uptimely's `src/lib/infra/code-mode-cpu-budget.ts`
 * (DevinoSolutions/uptimely#253), where the same wrapper was proven first.
 */

/** The error-code prefix a program stopped by the budget reports. */
export const CPU_BUDGET_EXCEEDED_CODE = 'CPU_BUDGET_EXCEEDED';

/**
 * Longest stretch a program may compute without awaiting an `external_*`
 * call. An orchestration program's own work (filtering, mapping, summing
 * results) takes milliseconds; 1.5s is far above that and still short enough
 * that one runaway program cannot noticeably stall the rest of the process.
 */
export const DEFAULT_CODE_MODE_CPU_BUDGET_MS = 1_500;

/**
 * Most a program may compute in total, summed across all its slices. Awaited
 * `external_*` time is excluded. Far above any real orchestration program, well
 * below the 30s deadline a compute/await loop could otherwise fill.
 */
export const DEFAULT_CODE_MODE_TOTAL_CPU_BUDGET_MS = 5_000;

type CpuBudgetOverrun = 'slice' | 'total';

type CodeModeRunOptions = Parameters<CodeModeTransport['run']>[0];

export type CpuBudgetedQuickJsTransportOptions = {
  /** `QuickJsCodeModeTransport`, from a lazily imported `@mastra/quickjs`. */
  Transport: typeof QuickJsCodeModeTransport;
  /** The QuickJS WASM module, from a lazily imported `quickjs-emscripten`'s `getQuickJS()`. */
  module: QuickJSWASMModule;
  /** See DEFAULT_CODE_MODE_CPU_BUDGET_MS. */
  cpuBudgetMs?: number | undefined;
  /** See DEFAULT_CODE_MODE_TOTAL_CPU_BUDGET_MS. */
  totalCpuBudgetMs?: number | undefined;
  /** QuickJS heap limit, passed straight to `QuickJsCodeModeTransport`. */
  memoryLimitMb?: number | undefined;
};

/** The budget of ONE program: its slices, their running total, and which cap overran. */
class ProgramCpuBudget {
  readonly #budgetMs: number;
  readonly #totalBudgetMs: number;
  readonly #abortRun: () => void;
  #sliceStartedAt: number | undefined;
  /** Compute of every slice that has already ended. */
  #completedSlicesMs = 0;
  #overrun: CpuBudgetOverrun | undefined;

  constructor(budgetMs: number, totalBudgetMs: number, abortRun: () => void) {
    this.#budgetMs = budgetMs;
    this.#totalBudgetMs = totalBudgetMs;
    this.#abortRun = abortRun;
  }

  get overrun(): CpuBudgetOverrun | undefined {
    return this.#overrun;
  }

  /** QuickJS's interrupt poll. `true` interrupts the guest. */
  readonly shouldInterrupt = (): boolean => {
    if (this.#overrun) return true;
    const now = performance.now();
    if (this.#sliceStartedAt === undefined) {
      this.#sliceStartedAt = now;
      // Runs only once the host's call stack has unwound — i.e. once this
      // slice of guest execution is over.
      queueMicrotask(() => {
        if (this.#sliceStartedAt !== undefined) {
          this.#completedSlicesMs += performance.now() - this.#sliceStartedAt;
        }
        this.#sliceStartedAt = undefined;
      });
    }
    const sliceMs = now - this.#sliceStartedAt;
    if (sliceMs > this.#budgetMs) this.#overrun = 'slice';
    else if (this.#completedSlicesMs + sliceMs > this.#totalBudgetMs) this.#overrun = 'total';
    else return false;
    this.#abortRun();
    return true;
  };
}

/** Binds each program's budget to the runtime `run()` creates for it. */
const programBudget = new AsyncLocalStorage<ProgramCpuBudget>();

/**
 * Installs `budget` as the runtime's interrupt handler for good, and turns the
 * transport's own `setInterruptHandler`/`removeInterruptHandler` calls into
 * swapping the handler composed behind it.
 */
function installCpuBudget(runtime: QuickJSRuntime, budget: ProgramCpuBudget): void {
  let transportHandler: InterruptHandler | undefined;
  const installHandler = runtime.setInterruptHandler.bind(runtime);
  runtime.setInterruptHandler = (handler: InterruptHandler) => {
    transportHandler = handler;
  };
  runtime.removeInterruptHandler = () => {
    transportHandler = undefined;
  };
  installHandler((rt) => budget.shouldInterrupt() || transportHandler?.(rt) === true);
}

/**
 * The module handed to `QuickJsCodeModeTransport`: the real one, except that
 * every runtime it creates carries the budget of the program creating it.
 */
function budgetedModule(module: QuickJSWASMModule): QuickJSWASMModule {
  const budgeted = Object.create(module) as QuickJSWASMModule;
  budgeted.newRuntime = (options?: RuntimeOptions) => {
    const budget = programBudget.getStore();
    if (!budget) {
      throw new Error(
        `${CPU_BUDGET_EXCEEDED_CODE} guard: a QuickJS runtime was created outside a budgeted run() — @mastra/quickjs no longer creates runtimes the way code-mode-cpu-budget.ts relies on; re-prove the budget before shipping this version`,
      );
    }
    const runtime = module.newRuntime(options);
    installCpuBudget(runtime, budget);
    return runtime;
  };
  return budgeted;
}

function cpuBudgetExceededResult(
  overrun: CpuBudgetOverrun,
  budgetMs: number,
  totalBudgetMs: number,
  logs: string[] | undefined,
): CodeModeToolResult {
  const reason =
    overrun === 'slice'
      ? `the program computed for more than ${budgetMs}ms without awaiting an external_* call, so it was stopped.`
      : `the program computed for more than ${totalBudgetMs}ms in total across its stretches between external_* calls (awaited time is not counted), so it was stopped.`;
  return {
    success: false,
    logs,
    error: {
      name: 'CpuBudgetExceededError',
      message: `${CPU_BUDGET_EXCEEDED_CODE}: ${reason} Keep loops short, and split heavy work across awaited external_* calls or several execute_typescript calls.`,
    },
  };
}

/**
 * `QuickJsCodeModeTransport` plus a per-slice and a total CPU budget. A drop-in
 * replacement: same `run()` contract, same result shape; a program that
 * overruns the budget resolves with `success: false` and an error whose message
 * starts with `CPU_BUDGET_EXCEEDED:`.
 */
export class CpuBudgetedQuickJsTransport implements CodeModeTransport {
  readonly requiresSandbox = false;
  readonly #cpuBudgetMs: number;
  readonly #totalCpuBudgetMs: number;
  readonly #transport: QuickJsCodeModeTransport;

  constructor({
    Transport,
    module,
    cpuBudgetMs,
    totalCpuBudgetMs,
    memoryLimitMb,
  }: CpuBudgetedQuickJsTransportOptions) {
    this.#cpuBudgetMs = cpuBudgetMs ?? DEFAULT_CODE_MODE_CPU_BUDGET_MS;
    this.#totalCpuBudgetMs = totalCpuBudgetMs ?? DEFAULT_CODE_MODE_TOTAL_CPU_BUDGET_MS;
    this.#transport = new Transport({
      ...(memoryLimitMb === undefined ? {} : { memoryLimitMb }),
      module: budgetedModule(module),
    });
  }

  async run(opts: CodeModeRunOptions): Promise<CodeModeToolResult> {
    const budgetAbort = new AbortController();
    const budget = new ProgramCpuBudget(this.#cpuBudgetMs, this.#totalCpuBudgetMs, () =>
      budgetAbort.abort(),
    );
    const abortSignal = opts.abortSignal
      ? AbortSignal.any([opts.abortSignal, budgetAbort.signal])
      : budgetAbort.signal;
    const result = await programBudget.run(budget, () =>
      this.#transport.run({ ...opts, abortSignal }),
    );
    return budget.overrun
      ? cpuBudgetExceededResult(
          budget.overrun,
          this.#cpuBudgetMs,
          this.#totalCpuBudgetMs,
          result.logs,
        )
      : result;
  }
}
