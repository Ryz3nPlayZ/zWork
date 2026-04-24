import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Artifact } from "../../lib/store";

export function ArtifactDocViewer({ artifact }: { artifact: Artifact }) {
  return (
    <div className="h-full overflow-auto bg-paper px-6 py-5">
      <article className="max-w-none text-[13.5px] leading-6 text-ink">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            h1: ({ children }) => (
              <h2 className="mb-2 mt-6 text-[17px] font-bold text-ink">{children}</h2>
            ),
            h2: ({ children }) => (
              <h3 className="mb-2 mt-5 text-[15px] font-semibold text-ink">{children}</h3>
            ),
            h3: ({ children }) => (
              <h4 className="mb-1 mt-4 text-[13.5px] font-semibold text-ink">{children}</h4>
            ),
            p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
            ul: ({ children }) => (
              <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="mb-3 list-decimal space-y-1 pl-5">{children}</ol>
            ),
            blockquote: ({ children }) => (
              <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-muted italic">
                {children}
              </blockquote>
            ),
            code: ({ className, children, ...props }) => {
              const match = /language-(\w+)/.exec(className || "");
              if (match || String(children).includes("\n")) {
                return (
                  <pre className="my-2 overflow-x-auto rounded-lg border border-line bg-paper-sunken p-3 text-[12px] font-mono">
                    <code>{children}</code>
                  </pre>
                );
              }
              return (
                <code className="rounded bg-paper-sunken px-1.5 py-0.5 text-[12px] font-mono text-ink" {...props}>
                  {children}
                </code>
              );
            },
            pre: ({ children }) => <>{children}</>,
            table: ({ children }) => (
              <div className="my-2 overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">{children}</table>
              </div>
            ),
            th: ({ children }) => (
              <th className="border border-line bg-paper-sunken px-3 py-1.5 text-left font-semibold">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="border border-line px-3 py-1.5">{children}</td>
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-ink underline underline-offset-2 hover:opacity-70"
              >
                {children}
              </a>
            ),
            strong: ({ children }) => (
              <strong className="font-semibold text-ink">{children}</strong>
            ),
            hr: () => <hr className="my-4 border-line" />,
          }}
        >
          {artifact.content}
        </ReactMarkdown>
      </article>
    </div>
  );
}
