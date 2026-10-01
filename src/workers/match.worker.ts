/**
 * R10-B 匹配求解 worker（独立 chunk，不进首屏包）。
 * 收消息 → 调 ops.solveMatchOp（逐段分位数统计 + CDL 三点拟合 + 拟合后距离）→ 回消息。
 */
import { solveMatchOp, type SolveReq, type SolveRes } from './ops-match';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<{ id: number; payload: SolveReq }>) => {
  const { id, payload } = ev.data;
  try {
    const result: SolveRes = solveMatchOp(payload);
    ctx.postMessage({ id, ok: true, result });
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: (e as Error).message });
  }
});
