import { Link } from "react-router-dom";
import { Logo } from "./Logo";

export function Footer() {
  return (
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
          <Link to="/changelog" className="hover:text-[#171716] transition-colors">
            Changelog
          </Link>
          <a href="#" aria-label="Read zWork documentation" className="hover:text-[#171716] transition-colors">
            Documentation
          </a>
          <a
            href="https://github.com/Ryz3nPlayZ/zWork"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View zWork source code on GitHub"
            className="hover:text-[#171716] transition-colors"
          >
            GitHub
          </a>
          <a href="#" className="hover:text-[#171716] transition-colors">
            Privacy
          </a>
        </div>
        <div className="text-[11.5px] text-[#a09e98]">
          &copy; 2026 zWork
        </div>
      </div>
    </footer>
  );
}
