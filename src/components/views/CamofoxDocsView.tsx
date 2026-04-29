import React from 'react';
import { FileText, Info, AlertTriangle, CheckCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import fs from 'fs';
import path from 'path';

async function CamofoxDocsView() {
  const filePath = path.join(process.cwd(), 'docs/camofox-custom.md');
  const content = fs.readFileSync(filePath, 'utf-8');

  return (
    <div className="absolute inset-0 overflow-y-auto px-6 pb-10 pt-2 custom-scrollbar">
      <div className="bg-[#0d111c]/70 border border-white/5 rounded-xl shadow-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/5">
          <h3 className="text-[13.5px] font-semibold text-slate-100 flex items-center gap-2">
            <FileText size={15} className="text-indigo-400" />
            Tài liệu Custom Camofox Browser
          </h3>
        </div>

        <div className="p-6 text-[13.5px] leading-relaxed text-slate-300 prose prose-invert prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ node, ...props }) => <h1 className="text-xl font-bold text-slate-100 mb-4 mt-6" {...props} />,
              h2: ({ node, ...props }) => <h2 className="text-lg font-semibold text-slate-100 mb-3 mt-5" {...props} />,
              h3: ({ node, ...props }) => <h3 className="text-md font-semibold text-slate-200 mb-2 mt-4" {...props} />,
              h4: ({ node, ...props }) => <h4 className="text-sm font-semibold text-slate-300 mb-2 mt-3" {...props} />,
              p: ({ node, ...props }) => <p className="mb-3" {...props} />,
              ul: ({ node, ...props }) => <ul className="pl-5 mb-4 list-disc space-y-1" {...props} />,
              ol: ({ node, ...props }) => <ol className="pl-5 mb-4 list-decimal space-y-1" {...props} />,
              li: ({ node, ...props }) => <li className="text-slate-300" {...props} />,
              code: ({ node, className, children, ...props }: any) => {
                const isInline = !className || !className.includes('language-');
                return isInline 
                  ? <code className="text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded text-xs" {...props}>{children}</code>
                  : <code className="block bg-[#050810] border border-white/10 rounded-lg p-4 text-xs font-mono text-slate-300 overflow-x-auto mb-4" {...props}>{children}</code>;
              },
              pre: ({ node, ...props }) => <pre className="bg-[#050810] border border-white/10 rounded-lg p-4 text-xs font-mono text-slate-300 overflow-x-auto mb-4" {...props} />,
              a: ({ node, ...props }) => <a className="text-indigo-400 hover:text-indigo-300 underline" {...props} />,
              blockquote: ({ node, ...props }) => <blockquote className="border-l-4 border-indigo-500 pl-4 italic text-slate-400 my-4" {...props} />,
              table: ({ node, ...props }) => <table className="w-full border-collapse mb-4 text-xs" {...props} />,
              th: ({ node, ...props }) => <th className="border border-white/10 px-3 py-2 bg-white/5 text-left font-semibold text-slate-200" {...props} />,
              td: ({ node, ...props }) => <td className="border border-white/10 px-3 py-2 text-slate-300" {...props} />,
              strong: ({ node, ...props }) => <strong className="font-semibold text-slate-100" {...props} />,
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
