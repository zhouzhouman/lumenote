import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 类名合并工具。clsx 处理条件类名，twMerge 处理 Tailwind 冲突 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}