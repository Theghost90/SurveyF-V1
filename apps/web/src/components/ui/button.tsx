import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-ink text-white hover:bg-ink-2',
        brand: 'bg-brand text-ink hover:bg-brand-2',
        outline: 'border border-line-2 bg-white text-ink hover:bg-canvas',
        ghost: 'text-ink hover:bg-mint/60',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        link: 'text-leaf underline-offset-4 hover:underline',
        dark: 'bg-ink-2 text-white hover:bg-ink-3',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        default: 'h-11 px-5 text-[15px]',
        lg: 'h-14 px-7 text-[17px] rounded-[14px]',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...(asChild ? {} : { type: props.type ?? 'button' })} {...props}>
      {asChild ? children : (<>{loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{children}</>)}
    </Comp>
  );
});
Button.displayName = 'Button';
