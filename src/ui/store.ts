/**
 * 工作台状态：单 store 对象 + 订阅刷新（不引框架）。
 * store.state 是配方运行时镜像（RecipeState）；store 持有配方身份（id/name/source），
 * 完整 JSON 按需经 recipe.buildRecipe 组装。所有变更经 setState 触发订阅者。
 */
import type { ImageStats } from '../engine';
import type { Origin, ViewMode } from '../film/params';
import {
  defaultColorParams,
  type RecipeState,
} from './recipe';

export type RefKind = 'library' | 'upload' | 'stock';

export interface RefSelection {
  kind: RefKind;
  /** 图库条目 id / 用户参考 id / 型号卡 id（fl05…） */
  id: string;
  label: string;
  stats: ImageStats | null;
}

export interface FrameInfo {
  name: string;
  stats: ImageStats;
  /** 预览源（已缩放画布） */
  canvas: HTMLCanvasElement;
}

export interface AppStore {
  frame: FrameInfo | null;
  ref: RefSelection | null;
  /** 当前配方运行时状态（null = 未选参考） */
  state: RecipeState | null;
  /** 参考选定时的初始配方快照（「一键重置」恢复目标） */
  initial: RecipeState | null;
  /** 配方身份（选定参考时固定） */
  recipeId: string;
  recipeName: string;
  viewMode: ViewMode;
  splitX: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();

export const store: AppStore = {
  frame: null,
  ref: null,
  state: null,
  initial: null,
  recipeId: '',
  recipeName: '',
  viewMode: 0,
  splitX: 0.5,
};

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(): void {
  for (const fn of [...listeners]) fn();
}

/** 选定参考 → 生成初始配方状态（③ 出配方）。中性=true 时色彩无统计对齐（选型号直出） */
export function initRecipeState(opts: {
  kind: RefKind;
  neutralMatch: boolean;
  look: RecipeState['look'];
  texture: RecipeState['texture'];
  origins: Record<string, Origin>;
  refStats: ImageStats | null;
}): RecipeState {
  return {
    colorParams: defaultColorParams(opts.neutralMatch),
    look: opts.look,
    texture: opts.texture,
    master: 1,
    origins: opts.origins,
    refStats: opts.refStats,
    userStats: store.frame?.stats ?? null,
  };
}
