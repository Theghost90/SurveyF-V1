import * as React from 'react';
import { cn } from '@/lib/utils';

export const Table = ({ className, ...p }: React.TableHTMLAttributes<HTMLTableElement>) => (
  <div className="w-full overflow-x-auto rounded-2xl border border-line"><table className={cn('w-full min-w-[560px] border-collapse text-sm', className)} {...p} /></div>
);
export const THead = ({ className, ...p }: React.HTMLAttributes<HTMLTableSectionElement>) => <thead className={cn('bg-canvas text-left text-xs uppercase tracking-wider text-muted-foreground', className)} {...p} />;
export const TBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} />;
export const TR = ({ className, ...p }: React.HTMLAttributes<HTMLTableRowElement>) => <tr className={cn('border-t border-line first:border-t-0 hover:bg-canvas/60', className)} {...p} />;
export const TH = ({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => <th scope="col" className={cn('px-4 py-3 font-bold', className)} {...p} />;
export const TD = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn('px-4 py-3 align-middle', className)} {...p} />;
