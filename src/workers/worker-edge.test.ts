/**
 * R13 · worker 客户端边界补测。
 *
 * workers.test.ts 已覆盖 5 条回退路径（无 Worker / 构造抛错 / 超时 / error 事件 / disable），
 * 但**未覆盖**：
 *   ① worker 以 `ok:false` 回报内部错误（不是抛错、也不是 error 事件）→ 必须回退同步路径；
 *   ② 并发请求竞态：多个 in-flight 请求的响应**乱序**到达时按 id 各归各位（拖动期间连续请求）；
 *   ③ 超时接管后，迟到响应必须被丢弃（不得二次 resolve / 不得重复调用同步路径）；
 *   ④ worker 返回 `ok:true` 的脏数据时的契约（原样透传；校验责任在 ops —— 见下方断言与说明）。
 */
import { describe, expect, it } from 'vitest';
import { createWorkerClient, type WorkerLike } from './client';

/** 可手动控制响应顺序的桩 worker */
function makeManualWorker(): {
  worker: WorkerLike;
  ids: number[];
  reply: (id: number, data: unknown) => void;
  errEvent: () => void;
} {
  const listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
  const ids: number[] = [];
  const emit = (type: string, ev: { data?: unknown }): void => { for (const cb of listeners[type] ?? []) cb(ev); };
  return {
    ids,
    worker: {
      postMessage(msg: unknown) { ids.push((msg as { id: number }).id); },
      addEventListener(type, cb) { (listeners[type] ??= []).push(cb); },
      terminate() { /* no-op */ },
    },
    reply: (id, data) => emit('message', { data }),
    errEvent: () => emit('error', {}),
  };
}

describe('R13 worker 边界：ok:false（内部错误）回退同步路径', () => {
  it('worker 以 ok:false 回报错误 → 该请求回退同步路径并得到可用结果', async () => {
    const w = makeManualWorker();
    const sync = (n: number): number => n * 2;
    const client = createWorkerClient<number, number>({
      name: 'ok-false', makeWorker: () => w.worker, sync, timeoutMs: 500, workerGlobalAvailable: true,
    });
    const p = client.run(21);
    await Promise.resolve();                       // 让 postMessage 落到 w.ids
    expect(w.ids).toEqual([1]);
    w.reply(1, { id: 1, ok: false, error: 'worker 内部异常' });
    await expect(p).resolves.toBe(42);             // 同步路径结果，而不是 reject
    expect(client.usingWorker).toBe(true);         // ok:false 不放弃 worker（与崩溃不同）
  });
});

describe('R13 worker 边界：并发请求竞态（乱序响应按 id 各归各位）', () => {
  it('3 个并发请求，响应逆序到达 → 每个请求拿到自己 id 的结果', async () => {
    const w = makeManualWorker();
    const client = createWorkerClient<number, number>({
      name: 'race', makeWorker: () => w.worker, sync: (n) => -n, timeoutMs: 1000, workerGlobalAvailable: true,
    });
    const ps = [client.run(1), client.run(2), client.run(3)];
    await Promise.resolve();
    expect(w.ids).toEqual([1, 2, 3]);
    // 逆序回复（模拟真实 worker 处理耗时不同）
    w.reply(3, { id: 3, ok: true, result: 30 });
    w.reply(1, { id: 1, ok: true, result: 10 });
    w.reply(2, { id: 2, ok: true, result: 20 });
    await expect(Promise.all(ps)).resolves.toEqual([10, 20, 30]);
  });

  it('拖动期间连续请求：worker 静默 → 全部超时后经同步路径返回（无请求悬挂）', async () => {
    const w = makeManualWorker();  // 永不回复
    const client = createWorkerClient<number, number>({
      name: 'drag', makeWorker: () => w.worker, sync: (n) => n + 100, timeoutMs: 15, workerGlobalAvailable: true,
    });
    const ps = [client.run(1), client.run(2), client.run(3), client.run(4)];
    await expect(Promise.all(ps)).resolves.toEqual([101, 102, 103, 104]);
    expect(client.usingWorker).toBe(false);        // 超时后已放弃 worker
  });

  it('超时接管后迟到响应被丢弃（不二次 resolve、不重复走同步路径）', async () => {
    const w = makeManualWorker();
    let syncCalls = 0;
    const client = createWorkerClient<number, number>({
      name: 'late', makeWorker: () => w.worker, sync: (n) => { syncCalls++; return n + 100; }, timeoutMs: 15, workerGlobalAvailable: true,
    });
    const p = client.run(1);
    await expect(p).resolves.toBe(101);
    expect(syncCalls).toBe(1);
    // 迟到的正常响应（同 id）：pending 已清空 → 丢弃
    w.reply(1, { id: 1, ok: true, result: 999 });
    await new Promise((r) => setTimeout(r, 5));
    expect(syncCalls).toBe(1);                     // 未被再次触发
  });
});

describe('R13 worker 边界：脏数据契约（ok:true 原样透传）', () => {
  it('ok:true 的结果原样返回（客户端不校验；真实 worker 入口与同步路径是同一函数，故不会产生脏数据）', async () => {
    const w = makeManualWorker();
    const sync = (): string => 'sync';
    const client = createWorkerClient<void, string>({
      name: 'dirty', makeWorker: () => w.worker, sync, timeoutMs: 500, workerGlobalAvailable: true,
    });
    const p = client.run();
    await Promise.resolve();
    w.reply(1, { id: 1, ok: true, result: 'DIRTY' });
    await expect(p).resolves.toBe('DIRTY');
    // 契约说明：worker 入口（ops-*.ts）与 sync 回退是同一函数，结构上保证一致性；
    // 任何结果校验都应放进 ops（见 workers.test.ts 的 ops ≡ 库函数断言），客户端不做二次猜测。
  });

  it('ok:false 与 error 事件的区别：前者不放弃 worker，后者 killWorker 后强制同步', async () => {
    const w = makeManualWorker();
    const client = createWorkerClient<number, number>({
      name: 'mix', makeWorker: () => w.worker, sync: (n) => n, timeoutMs: 500, workerGlobalAvailable: true,
    });
    const p1 = client.run(1);
    await Promise.resolve();
    w.reply(1, { id: 1, ok: false, error: 'x' });
    await p1;
    expect(client.usingWorker).toBe(true);         // ok:false 后仍在用 worker
    const p2 = client.run(2);
    await Promise.resolve();
    w.errEvent();                                  // 崩溃事件
    await expect(p2).resolves.toBe(2);
    expect(client.usingWorker).toBe(false);
  });
});
