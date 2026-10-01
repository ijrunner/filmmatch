/**
 * R10-B 通用 Worker 客户端：**worker 优先，主线程同步回退**。
 *
 * 回退条件（任一命中即退回主线程同步路径）：
 *   - `typeof Worker === 'undefined'`（非浏览器 / 老环境）；
 *   - worker 构造抛异常；
 *   - 单次请求超时（默认见各调用点 timeoutMs）；
 *   - worker 触发 error 事件 / postMessage 抛异常。
 *
 * 结果一致性：worker 入口与同步回退都调用 src/workers/ops.ts 的**同一函数**，
 * 故「同一输入 → 同一输出」是结构保证（tests 断言逐位相等）。
 *
 * 本模块在 import 期不触碰 `Worker`（惰性创建），因此可在 node/vitest 下被安全导入。
 */

/** 最小 worker 接口（便于测试注入桩；浏览器 Worker 结构兼容） */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void;
  terminate(): void;
}

export interface WorkerClient<Req, Res> {
  /** 执行一次请求：worker 可用则走 worker，否则/失败/超时退回同步路径 */
  run(req: Req): Promise<Res>;
  /** 当前是否真的在使用 worker（惰性创建后才有意义） */
  readonly usingWorker: boolean;
  /** 强制退回同步路径（测试/降级用） */
  disable(): void;
  dispose(): void;
}

interface Pending<Req, Res> {
  req: Req;
  resolve: (r: Res) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WireRes<Res> { id: number; ok: boolean; result?: Res; error?: string }

export function createWorkerClient<Req, Res>(opts: {
  name: string;
  /** 惰性创建 worker；返回 null 表示不可用 */
  makeWorker: () => WorkerLike | null;
  /** 主线程同步实现（与 worker 入口同一函数） */
  sync: (req: Req) => Res;
  timeoutMs?: number;
  /** 环境是否提供全局 Worker（默认自动探测；测试可显式覆盖） */
  workerGlobalAvailable?: boolean;
}): WorkerClient<Req, Res> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const hasWorkerGlobal = (): boolean => opts.workerGlobalAvailable ?? (typeof Worker !== 'undefined');
  let worker: WorkerLike | null = null;
  let started = false;
  let forcedOff = false;
  let disposed = false;
  let seq = 0;
  const pending = new Map<number, Pending<Req, Res>>();

  const runSync = (req: Req): Res => opts.sync(req);

  /** worker 崩溃/超时：终止并把所有待决请求改走同步路径 */
  const killWorker = (): void => {
    const w = worker;
    worker = null;
    started = true; // 不再重建，避免反复崩溃
    if (w) { try { w.terminate(); } catch { /* ignore */ } }
    const items = [...pending.values()];
    pending.clear();
    for (const p of items) {
      clearTimeout(p.timer);
      p.resolve(runSync(p.req));
    }
  };

  const ensureWorker = (): WorkerLike | null => {
    if (started) return worker;
    started = true;
    if (forcedOff || !hasWorkerGlobal()) { worker = null; return null; }
    try {
      worker = opts.makeWorker();
      if (!worker) return null;
      worker.addEventListener('message', (ev) => {
        const d = ev.data as WireRes<Res> | undefined;
        if (!d || typeof d.id !== 'number') return;
        const p = pending.get(d.id);
        if (!p) return; // 已被超时/降级接管 → 丢弃迟到响应
        pending.delete(d.id);
        clearTimeout(p.timer);
        if (d.ok) p.resolve(d.result as Res);
        else p.resolve(runSync(p.req)); // worker 内部报错 → 退回同步，保证有结果
      });
      worker.addEventListener('error', () => { killWorker(); });
    } catch {
      worker = null;
    }
    return worker;
  };

  const run = (req: Req): Promise<Res> => {
    if (disposed) return Promise.resolve().then(() => runSync(req));
    const w = ensureWorker();
    if (!w) return Promise.resolve().then(() => runSync(req));
    const id = ++seq;
    return new Promise<Res>((resolve) => {
      const timer = setTimeout(() => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        // 超时 → 放弃该 worker（含其余待决请求），本请求走同步路径
        killWorker();
        resolve(runSync(req));
      }, timeoutMs);
      pending.set(id, { req, resolve, timer });
      try {
        w.postMessage({ id, payload: req });
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        resolve(runSync(req));
      }
    });
  };

  return {
    run,
    get usingWorker(): boolean { return !!worker; },
    disable(): void { forcedOff = true; if (worker) killWorker(); },
    dispose(): void {
      disposed = true;
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
      pending.clear();
    },
  };
}
