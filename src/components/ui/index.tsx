import React from 'react';

// --- Button ---
export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'icon', size?: 'sm' | 'md' | 'lg' | 'icon-sm' }>(
    ({ className = '', variant = 'secondary', size = 'md', children, ...props }, ref) => {
        const base = "inline-flex items-center justify-center gap-1.5 font-medium transition-all duration-150 outline-none rounded-md disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";

        const variants = {
            primary: "bg-gradient-to-br from-indigo-500 to-indigo-600 text-white border border-indigo-500/40 shadow-[0_0_15px_rgba(99,102,241,0.2)] hover:shadow-[0_4px_20px_rgba(99,102,241,0.3)] hover:-translate-y-[1px]",
            secondary: "bg-white/5 text-slate-200 border border-white/10 hover:bg-white/10 hover:border-white/20",
            ghost: "bg-transparent text-slate-400 border border-transparent hover:bg-white/5 hover:text-slate-200 hover:border-white/10",
            danger: "bg-rose-500/10 text-rose-500 border border-rose-500/20 hover:bg-rose-500/20 hover:shadow-[0_0_12px_rgba(244,63,94,0.2)]",
            success: "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20 hover:shadow-[0_0_12px_rgba(16,185,129,0.2)]",
            icon: "bg-white/5 text-slate-400 border border-white/10 hover:bg-white/10 hover:text-slate-200 hover:border-white/20 p-0"
        };

        const sizes = {
            sm: "px-2.5 py-1 text-[11.5px]",
            md: "px-3.5 py-1.5 text-[12.5px]",
            lg: "px-5 py-2 text-sm",
            "icon-sm": "w-7 h-7 text-[13px]"
        };

        const isIcon = variant === 'icon';

        return (
            <button ref={ref} className={`${base} ${variants[variant]} ${isIcon ? sizes['icon-sm'] : sizes[size]} ${className}`} {...props}>
                {children}
            </button>
        );
    }
);
Button.displayName = 'Button';

// --- Card ---
export const Card = ({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div className={`bg-[#0d111c]/70 border border-white/5 rounded-xl backdrop-blur-md shadow-lg overflow-hidden ${className}`} {...props}>
        {children}
    </div>
);

export const CardHeader = ({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div className={`px-4 py-3 border-b border-white/5 flex items-center justify-between gap-3 flex-wrap ${className}`} {...props}>
        {children}
    </div>
);

export const CardTitle = ({ className = '', children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className={`text-[13.5px] font-semibold text-slate-100 flex items-center gap-2 ${className}`} {...props}>
        {children}
    </h3>
);

export const CardContent = ({ className = '', children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div className={`p-4 ${className}`} {...props}>
        {children}
    </div>
);

// --- Input ---
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
    ({ className = '', mono, ...props }, ref) => (
        <input
            ref={ref}
            className={`w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[13px] text-slate-100 outline-none transition-all placeholder:text-slate-500 focus:bg-white/10 focus:border-indigo-500/50 focus:ring-2 focus:ring-indigo-500/20 ${mono ? 'font-mono text-xs' : ''} ${className}`}
            {...props}
        />
    )
);
Input.displayName = 'Input';

// --- Stat Box ---
export const StatBox = ({ label, value, icon: Icon, colorClass, borderClass, bgClass, active, onClick }: any) => {
    return (
        <div
            className={`relative p-4 rounded-xl flex items-center gap-4 transition-all duration-200 overflow-hidden ${active ? `bg-white/5 border ${borderClass} shadow-[0_4px_24px_-4px_rgba(0,0,0,0.5)]` : 'bg-white/[0.02] border border-white/5 hover:border-white/10 hover:-translate-y-[2px] cursor-pointer shadow-md'}`}
            onClick={onClick}
        >
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${bgClass} ${colorClass}`}>
                <Icon size={20} />
            </div>
            <div className="relative z-10">
                <div className="text-xs font-medium text-slate-400">{label}</div>
                <div className="text-xl font-bold text-slate-100 mt-0.5 leading-none">{value}</div>
            </div>
            {active && <div className={`absolute -right-4 -bottom-4 w-16 h-16 rounded-full opacity-10 ${bgClass}`} />}
        </div>
    );
};
