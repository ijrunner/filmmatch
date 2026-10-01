/**
 * R10-B LUT 烘焙 worker（独立 chunk，不进首屏包）。
 * 收消息 → 调 ops.bakeLutOp → 回消息；结果 Float32 表按 transferable 零拷贝回传。
 */
import { bakeLutOp, type BakeLutReq, type BakeLutRes } from './ops-lut';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<{ id: number; payload: BakeLutReq }>) => {
  const { id, payload } = ev.data;
  try {
    const result: BakeLutRes = bakeLutOp(payload);
    const buf = result.table.buffer as ArrayBuffer;
    ctx.postMessage({ id, ok: true, result }, [buf]);
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: (e as Error).message });
  }
});
