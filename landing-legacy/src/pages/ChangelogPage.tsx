import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Link } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { Logo } from "../components/Logo";

gsap.registerPlugin(ScrollTrigger);

const serif = { fontFamily: "var(--font-serif)" };

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  published_at: string;
  body: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

interface ReleaseBody {
  title: string;
  changes: string[];
}

function parseReleaseBody(body: string): ReleaseBody | null {
  if (!body) return null;

  // Find the "What's new" section
  const whatsNewMatch = body.match(/## What['']s new\s*\n\n([\s\S]+?)(?=##|\n\n---|\n\n\[|$)/);
  if (!whatsNewMatch) return null;

  const content = whatsNewMatch[1].trim();

  // Extract the title/bold line
  const titleMatch = content.match(/^\*\*([^*]+)\*\*/);
  const title = titleMatch ? titleMatch[1] : "What's new";

  // Extract bullet points
  const changes: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      changes.push(trimmed.substring(2));
    }
  }

  if (changes.length === 0) {
    // If no bullet points, use the whole content as a single change
    const cleanContent = content.replace(/^\*\*[^\*]+\*\*\s*/, '').trim();
    if (cleanContent) {
      changes.push(cleanContent);
    }
  }

  return { title, changes };
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

export default function ChangelogPage() {
  const [releases, setReleases] = useState<GitHubRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const pageRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const fetchReleases = async () => {
      try {
        const response = await fetch('https://api.github.com/repos/Ryz3nPlayZ/zWork/releases?per_page=10');
        const data = await response.json();
        setReleases(data.filter((r: GitHubRelease) => !r.draft && !r.prerelease));
      } catch (error) {
        console.error('Failed to fetch releases:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchReleases();
  }, []);

  useEffect(() => {
    if (loading) return;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        pageRef.current,
        { y: 30, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.7, ease: "power2.out" }
      );

      itemsRef.current.forEach((item) => {
        if (!item) return;
        gsap.fromTo(
          item,
          { y: 50, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.8,
            ease: "power2.out",
            scrollTrigger: {
              trigger: item,
              start: "top 85%",
              toggleActions: "play none none none",
            },
          }
        );
      });
    });
    return () => ctx.revert();
  }, [loading]);

  return (
    <div ref={pageRef} className="relative min-h-screen bg-[#f7f6f3]">
      <TopBar visible={true} />

      {/* Subtle CTA banner */}
      <div className="border-b border-[#e6e3dc] bg-[#f7f6f3]">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <span className="text-[13px] text-[#6b6a65]">
            New to zWork? Download for free and start shipping faster.
          </span>
          <Link
            to="/download"
            className="text-[13px] font-semibold text-[#171716] hover:text-[#6b6a65] transition-colors"
          >
            Download →
          </Link>
        </div>
      </div>

      <section className="relative z-50 bg-[#f7f6f3] pt-32 md:pt-40 px-6">
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="mb-16 md:mb-24">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#6b6a65] block mb-4">
              Changelog
            </span>
            <h2
              className="text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tight text-[#171716]"
              style={serif}
            >
              What's new in zWork
            </h2>
            <p className="mt-6 text-lg md:text-xl text-[#6b6a65] max-w-2xl leading-relaxed">
              Track the latest features, fixes, and improvements.
            </p>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="text-center py-20">
              <p className="text-[#6b6a65]">Loading releases...</p>
            </div>
          )}

          {/* Releases list */}
          {!loading && releases.length === 0 && (
            <div className="text-center py-20">
              <p className="text-[#6b6a65]">No releases found.</p>
            </div>
          )}

          <div className="space-y-16 md:space-y-24 pb-32">
            {releases.map((release, index) => {
              const parsed = parseReleaseBody(release.body);

              return (
                <div
                  key={release.id}
                  ref={(el) => { itemsRef.current[index] = el; }}
                  className="border-t border-[#e6e3dc] pt-12 md:pt-16"
                >
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
                    <div>
                      <h3 className="text-2xl md:text-3xl font-semibold tracking-tight text-[#171716]" style={serif}>
                        {release.name}
                      </h3>
                      <p className="mt-1 text-[13px] text-[#6b6a65]">
                        {formatDate(release.published_at)}
                      </p>
                    </div>
                    <a
                      href={release.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] font-medium text-[#6b6a65] hover:text-[#171716] transition-colors"
                    >
                      View on GitHub →
                    </a>
                  </div>

                  {parsed && parsed.changes.length > 0 && (
                    <div className="space-y-4">
                      {parsed.title && !parsed.title.includes("What's new") && (
                        <p className="text-lg md:text-xl text-[#171716] font-medium" style={serif}>
                          {parsed.title}
                        </p>
                      )}
                      <ul className="space-y-3">
                        {parsed.changes.map((change, i) => (
                          <li key={i} className="flex items-start gap-3">
                            <span className="text-[#a09e98] mt-1">—</span>
                            <span className="text-[15px] text-[#6b6a65] leading-relaxed flex-1">
                              {change}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Fallback: show raw body if parsing failed */}
                  {!parsed && release.body && (
                    <div className="prose prose-sm max-w-none">
                      <p className="text-[15px] text-[#6b6a65] leading-relaxed whitespace-pre-line">
                        {release.body.split('---')[0]?.trim()}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-50 border-t border-[#e6e3dc] bg-[#f7f6f3] py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <Logo size={22} fill="#171716" />
            <span className="text-[13px] font-semibold tracking-tight text-[#171716]">
              <span className="lowercase">z</span>Work
            </span>
          </div>
          <div className="flex items-center gap-6 text-[12.5px] text-[#6b6a65]">
            <Link to="/features" className="hover:text-[#171716] transition-colors">
              Features
            </Link>
            <Link to="/pricing" className="hover:text-[#171716] transition-colors">
              Pricing
            </Link>
            <a href="#" className="hover:text-[#171716] transition-colors">
              Documentation
            </a>
            <a
              href="https://github.com/Ryz3nPlayZ/zWork"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#171716] transition-colors"
            >
              GitHub
            </a>
          </div>
          <div className="text-[11.5px] text-[#a09e98]">
            &copy; 2026 zWork
          </div>
        </div>
      </footer>
    </div>
  );
}
