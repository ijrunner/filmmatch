/**
 * R10-B 批量导出打包 worker（独立 chunk，不进首屏包）。
 * 收消息 → 调 ops.buildPackOp（LUT 烘焙 + DCTL 生成 + 打包 + zip）→ 回消息；
 * zip 字节按 transferable 零拷贝回传。
 */
import { buildPackOp, type PackReq, type PackRes } from './ops-pack';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<{ id: number; payload: PackReq }>) => {
  const { id, payload } = ev.data;
  try {
    const result: PackRes = buildPackOp(payload);
    const buf = result.zip.buffer as ArrayBuffer;
    ctx.postMessage({ id, ok: true, result }, [buf]);
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: (e as Error).message });
  }
});
