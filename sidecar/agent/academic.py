"""Academic literature search tool for zWork.

Merges multiple free academic APIs in parallel:
  - Semantic Scholar (CS, ML, biomed)
  - arXiv (physics, math, CS preprints)
  - OpenAlex (public health, medicine, sociology, econ)
  - CrossRef (journal metadata, 150M+ works)
  - Unpaywall (open-access PDF locator)

No API keys strictly required — all sources have anonymous tiers.
Keys in the env improve rate limits.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

# ── Result shape ────────────────────────────────────────────────────────────


@dataclass
class PaperResult:
    title: str
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    abstract: str = ""
    citation_count: int = 0
    doi: str | None = None
    url: str = ""
    pdf_url: str | None = None
    source: str = ""  # "semantic_scholar" | "arxiv" | "openalex" | "crossref"
    journal: str = ""


# ═══════════════════════════════════════════════════════════════════════════════
# API Clients
# ═══════════════════════════════════════════════════════════════════════════════


class SemanticScholarClient:
    """Free tier: 1 req/s anonymous, 10 req/s with API key."""

    BASE = "https://api.semanticscholar.org/graph/v1"

    def __init__(self) -> None:
        self.api_key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY", "")
        self._http: httpx.AsyncClient | None = None
        self._last_request = 0.0
        self._interval = 1.0  # Semantic Scholar keys are 1 req/s
        self._lock = asyncio.Lock()

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=30.0)
        return self._http

    async def _rate_limit(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = self._interval - (now - self._last_request)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request = time.monotonic()

    async def search(self, query: str, limit: int = 20) -> list[PaperResult]:
        await self._rate_limit()
        headers = {"x-api-key": self.api_key} if self.api_key else {}
        fields = "paperId,title,abstract,authors,year,citationCount,url,openAccessPdf,externalIds,journal"
        try:
            client = await self._get_client()
            r = await client.get(
                f"{self.BASE}/paper/search",
                params={"query": query, "limit": limit, "fields": fields},
                headers=headers,
            )
            if r.status_code == 429:
                logger.warning("Semantic Scholar rate limited")
                return []
            if r.status_code == 403:
                logger.warning(
                    "Semantic Scholar API key invalid — using anonymous tier"
                )
                return []
            r.raise_for_status()
            data = r.json()
            results: list[PaperResult] = []
            for p in data.get("data", []) or []:
                ext = p.get("externalIds") or {}
                doi = ext.get("DOI") or ""
                oa = p.get("openAccessPdf") or {}
                j = p.get("journal") or {}
                results.append(
                    PaperResult(
                        title=p.get("title", ""),
                        authors=[a.get("name", "") for a in (p.get("authors") or [])],
                        year=p.get("year"),
                        abstract=p.get("abstract") or "",
                        citation_count=p.get("citationCount") or 0,
                        doi=doi or None,
                        url=p.get("url", ""),
                        pdf_url=oa.get("url"),
                        source="semantic_scholar",
                        journal=j.get("name", "") if j else "",
                    )
                )
            return results
        except Exception as e:
            logger.debug(f"Semantic Scholar error: {e}")
            return []


class ArxivClient:
    """Free, no key needed. Physics, math, CS preprints."""

    BASE = "https://export.arxiv.org/api/query"

    def __init__(self) -> None:
        self._http: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=30.0, follow_redirects=True)
        return self._http

    async def search(self, query: str, limit: int = 20) -> list[PaperResult]:
        import xml.etree.ElementTree as ET

        try:
            client = await self._get_client()
            r = await client.get(
                self.BASE,
                params={
                    "search_query": f"all:{query}",
                    "start": 0,
                    "max_results": limit,
                    "sortBy": "relevance",
                },
            )
            r.raise_for_status()
            ns = {
                "a": "http://www.w3.org/2005/Atom",
                "arxiv": "http://arxiv.org/schemas/atom",
            }
            root = ET.fromstring(r.text)
            results: list[PaperResult] = []
            for entry in root.findall("a:entry", ns):
                title_el = entry.find("a:title", ns)
                title = (
                    (title_el.text or "").strip().replace("\n", " ")
                    if title_el is not None
                    else ""
                )
                summary_el = entry.find("a:summary", ns)
                abstract = (
                    (summary_el.text or "").strip().replace("\n", " ")
                    if summary_el is not None
                    else ""
                )
                authors: list[str] = []
                for author in entry.findall("a:author", ns):
                    name_el = author.find("a:name", ns)
                    if name_el is not None and name_el.text:
                        authors.append(name_el.text.strip())
                arxiv_id = ""
                id_el = entry.find("a:id", ns)
                if id_el is not None and id_el.text:
                    arxiv_id = id_el.text.split("/abs/")[-1]
                published = entry.find("a:published", ns)
                year = (
                    int((published.text or "2025")[:4])
                    if published is not None and published.text
                    else None
                )
                results.append(
                    PaperResult(
                        title=title,
                        authors=authors,
                        year=year,
                        abstract=abstract,
                        url=f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else "",
                        pdf_url=f"https://arxiv.org/pdf/{arxiv_id}"
                        if arxiv_id
                        else None,
                        source="arxiv",
                    )
                )
            return results
        except Exception as e:
            logger.debug(f"arXiv error: {e}")
            return []


class OpenAlexClient:
    """Free, no key. Strong for medicine, public health, sociology."""

    BASE = "https://api.openalex.org"

    def __init__(self) -> None:
        self.email = os.environ.get("UNPAYWALL_EMAIL", "")
        self.api_key = os.environ.get("OPENALEX_API_KEY", "")
        self._http: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=20.0)
        return self._http

    @staticmethod
    def _reconstruct_abstract(inverted: dict | None) -> str:
        if not inverted:
            return ""
        positions: list[tuple[int, str]] = []
        for word, pos_list in inverted.items():
            for p in pos_list:
                positions.append((p, word))
        positions.sort(key=lambda x: x[0])
        return " ".join(w for _, w in positions)

    async def search(self, query: str, limit: int = 20) -> list[PaperResult]:
        try:
            params: dict[str, Any] = {
                "filter": f"title_and_abstract.search:{query}",
                "per-page": min(limit, 200),
                "sort": "relevance_score:desc",
                "select": "id,title,abstract_inverted_index,authorships,publication_year,cited_by_count,doi,primary_location,open_access",
            }
            if self.email:
                params["mailto"] = self.email
            if self.api_key:
                params["api_key"] = self.api_key
            client = await self._get_client()
            r = await client.get(f"{self.BASE}/works", params=params)
            if r.status_code == 429:
                logger.warning("OpenAlex rate limited")
                return []
            if r.status_code != 200:
                return []
            data = r.json()
            results: list[PaperResult] = []
            for work in data.get("results") or []:
                title = (work.get("title") or "").strip()
                if not title:
                    continue
                abstract = self._reconstruct_abstract(
                    work.get("abstract_inverted_index")
                )
                authors: list[str] = []
                for a in work.get("authorships") or []:
                    auth = a.get("author") or {}
                    name = auth.get("display_name", "")
                    if name:
                        authors.append(name)
                doi_raw = (
                    (work.get("doi") or "").replace("https://doi.org/", "").strip()
                )
                oa = work.get("open_access") or {}
                pdf_url = oa.get("oa_url")
                if not pdf_url:
                    loc = work.get("primary_location") or {}
                    pdf_url = loc.get("pdf_url")
                results.append(
                    PaperResult(
                        title=title,
                        authors=authors,
                        year=work.get("publication_year"),
                        abstract=abstract,
                        citation_count=work.get("cited_by_count") or 0,
                        doi=doi_raw or None,
                        url=f"https://doi.org/{doi_raw}"
                        if doi_raw
                        else (work.get("id") or ""),
                        pdf_url=pdf_url,
                        source="openalex",
                    )
                )
            return results
        except Exception as e:
            logger.debug(f"OpenAlex error: {e}")
            return []


class CrossrefClient:
    """Free, email for polite pool (50 req/s). Best journal metadata."""

    BASE = "https://api.crossref.org"

    def __init__(self) -> None:
        self.email = os.environ.get("UNPAYWALL_EMAIL", "")
        self._http: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=20.0)
        return self._http

    def _headers(self) -> dict[str, str]:
        ua = f"zWork/1.0 (mailto:{self.email})" if self.email else "zWork/1.0"
        return {"User-Agent": ua}

    async def search(self, query: str, limit: int = 20) -> list[PaperResult]:
        try:
            client = await self._get_client()
            r = await client.get(
                f"{self.BASE}/works",
                params={"query": query, "rows": min(limit, 100), "sort": "relevance"},
                headers=self._headers(),
            )
            if r.status_code == 429:
                logger.warning("Crossref rate limited")
                return []
            r.raise_for_status()
            data = r.json()
            results: list[PaperResult] = []
            for item in data.get("message", {}).get("items") or []:
                title_list = item.get("title") or []
                title = title_list[0] if title_list else ""
                if not title:
                    continue
                authors: list[str] = []
                for a in item.get("author") or []:
                    g = a.get("given", "")
                    f = a.get("family", "")
                    if g and f:
                        authors.append(f"{g} {f}")
                    elif f:
                        authors.append(f)
                pub = (
                    item.get("published-print")
                    or item.get("published-online")
                    or item.get("published")
                    or {}
                )
                date_parts = pub.get("date-parts", [[None]])[0] if pub else [None]
                year = date_parts[0] if date_parts else None
                doi = item.get("DOI", "")
                container = item.get("container-title") or []
                journal = container[0] if container else ""
                results.append(
                    PaperResult(
                        title=title,
                        authors=authors,
                        year=year,
                        abstract=(item.get("abstract") or ""),
                        citation_count=item.get("is-referenced-by-count") or 0,
                        doi=doi or None,
                        url=f"https://doi.org/{doi}" if doi else "",
                        source="crossref",
                        journal=journal,
                    )
                )
            return results
        except Exception as e:
            logger.debug(f"Crossref error: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════════
# De-duplication & Ranking
# ═══════════════════════════════════════════════════════════════════════════════


def _norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


def _deduplicate(papers: list[PaperResult]) -> list[PaperResult]:
    """Merge duplicates by title similarity, keeping best metadata."""
    seen: dict[str, PaperResult] = {}
    for p in papers:
        key = _norm_title(p.title)[:60]
        if key in seen:
            existing = seen[key]
            # Merge: prefer non-empty fields
            if not existing.abstract and p.abstract:
                existing.abstract = p.abstract
            if not existing.doi and p.doi:
                existing.doi = p.doi
            if not existing.pdf_url and p.pdf_url:
                existing.pdf_url = p.pdf_url
            if not existing.journal and p.journal:
                existing.journal = p.journal
            if p.citation_count > existing.citation_count:
                existing.citation_count = p.citation_count
            existing.source = f"{existing.source}+{p.source}"
        else:
            seen[key] = p
    return list(seen.values())


def _rank(papers: list[PaperResult]) -> list[PaperResult]:
    """Score by citation count + has_abstract + has_pdf + recency."""
    current_year = time.localtime().tm_year

    def score(p: PaperResult) -> float:
        s = 0.0
        # Citation signal (log scale to not overwhelm)
        if p.citation_count > 0:
            import math

            s += math.log(1 + p.citation_count) * 2.0
        # Has abstract
        if p.abstract:
            s += 3.0
        # Has open-access PDF
        if p.pdf_url:
            s += 4.0
        # Recency bonus
        if p.year and p.year >= current_year - 2:
            s += 2.0
        elif p.year and p.year >= current_year - 5:
            s += 1.0
        return s

    return sorted(papers, key=score, reverse=True)


# ═══════════════════════════════════════════════════════════════════════════════
# Public entry point
# ═══════════════════════════════════════════════════════════════════════════════


async def search_academic_literature(
    query: str,
    max_results: int = 20,
    year_min: int | None = None,
    year_max: int | None = None,
) -> list[dict[str, Any]]:
    """Search academic literature across multiple free sources in parallel.

    Returns a ranked, de-duplicated list of paper dicts.
    """
    if not query or not query.strip():
        return []

    query = query.strip()
    limit_per_source = max(10, max_results)

    # Fire all sources in parallel with individual timeouts
    ss = SemanticScholarClient()
    arxiv = ArxivClient()
    oa = OpenAlexClient()
    cr = CrossrefClient()

    async def _safe_search(client: Any, q: str, lim: int) -> list[PaperResult]:
        try:
            return await asyncio.wait_for(client.search(q, lim), timeout=25.0)
        except asyncio.TimeoutError:
            logger.debug(f"{type(client).__name__} timed out")
            return []
        except Exception as e:
            logger.debug(f"{type(client).__name__} error: {e}")
            return []

    results: list[list[PaperResult]] = await asyncio.gather(
        _safe_search(ss, query, limit_per_source),
        _safe_search(arxiv, query, limit_per_source),
        _safe_search(oa, query, limit_per_source),
        _safe_search(cr, query, limit_per_source),
    )

    # Flatten (ignore exceptions)
    all_papers: list[PaperResult] = []
    for r in results:
        if isinstance(r, list):
            all_papers.extend(r)

    # Deduplicate and rank
    all_papers = _deduplicate(all_papers)
    all_papers = _rank(all_papers)

    # Apply year filter
    if year_min is not None or year_max is not None:
        filtered: list[PaperResult] = []
        for p in all_papers:
            if p.year is None:
                filtered.append(p)  # keep papers with unknown year
                continue
            if year_min is not None and p.year < year_min:
                continue
            if year_max is not None and p.year > year_max:
                continue
            filtered.append(p)
        all_papers = filtered

    # Cap
    all_papers = all_papers[:max_results]

    # Convert to dicts for tool_result
    return [
        {
            "title": p.title,
            "authors": p.authors,
            "year": p.year,
            "abstract": p.abstract[:800] + "…" if len(p.abstract) > 800 else p.abstract,
            "citation_count": p.citation_count,
            "doi": p.doi,
            "url": p.url,
            "pdf_url": p.pdf_url,
            "source": p.source,
            "journal": p.journal,
        }
        for p in all_papers
    ]


async def search_paper_by_doi(doi: str) -> dict[str, Any] | None:
    """Look up a specific paper by DOI via OpenAlex + Unpaywall."""
    doi = doi.strip().replace("https://doi.org/", "")
    if not doi:
        return None

    # Try OpenAlex first
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"https://api.openalex.org/works/doi:{doi}")
            if r.status_code == 200:
                work = r.json()
                title = (work.get("title") or "").strip()
                if title:
                    authors: list[str] = []
                    for a in work.get("authorships") or []:
                        auth = a.get("author") or {}
                        name = auth.get("display_name", "")
                        if name:
                            authors.append(name)
                    oa = work.get("open_access") or {}
                    pdf_url = oa.get("oa_url")
                    return {
                        "title": title,
                        "authors": authors,
                        "year": work.get("publication_year"),
                        "doi": doi,
                        "url": f"https://doi.org/{doi}",
                        "pdf_url": pdf_url,
                        "citation_count": work.get("cited_by_count") or 0,
                    }
    except Exception:
        pass

    # Try Unpaywall for open-access PDF
    email = os.environ.get("UNPAYWALL_EMAIL", "")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            params: dict[str, str] = {"doi": doi}
            if email:
                params["email"] = email
            r = await client.get("https://api.unpaywall.org/v2/search", params=params)
            if r.status_code == 200:
                data = r.json()
                results = data.get("results", [])
                if results:
                    first = results[0]
                    resp = first.get("response") or {}
                    best = resp.get("best_oa_location") or {}
                    return {
                        "title": resp.get("title", ""),
                        "doi": doi,
                        "url": f"https://doi.org/{doi}",
                        "pdf_url": best.get("url_for_pdf"),
                        "year": resp.get("year"),
                        "source": "unpaywall",
                    }
    except Exception:
        pass

    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Citation formatting
# ═══════════════════════════════════════════════════════════════════════════════


def format_citation(
    paper: dict[str, Any],
    style: str = "apa",
) -> str:
    """Format a paper dict into a citation string.

    Args:
        paper: Dict with title, authors, year, doi, journal fields
        style: "apa", "mla", or "chicago"

    Returns:
        Formatted citation string
    """
    authors: list[str] = paper.get("authors") or []
    year = paper.get("year")
    title = (paper.get("title") or "").strip()
    journal = (paper.get("journal") or "").strip()
    doi = paper.get("doi")

    if not title:
        return ""

    style = style.lower()
    if style == "apa":
        return _format_apa(authors, year, title, journal, doi)
    elif style == "mla":
        return _format_mla(authors, year, title, journal, doi)
    elif style == "chicago":
        return _format_chicago(authors, year, title, journal, doi)
    else:
        return _format_apa(authors, year, title, journal, doi)


def _format_authors_apa(authors: list[str]) -> str:
    if not authors:
        return ""
    if len(authors) == 1:
        parts = authors[0].split()
        if len(parts) >= 2:
            return f"{parts[-1]}, {''.join(p[0] + '. ' for p in parts[:-1])}".strip()
        return authors[0]
    if len(authors) <= 7:
        formatted = []
        for a in authors:
            parts = a.split()
            if len(parts) >= 2:
                initials = "".join(p[0] + ". " for p in parts[:-1]).strip()
                formatted.append(f"{parts[-1]}, {initials}")
            else:
                formatted.append(a)
        return ", ".join(formatted[:-1]) + ", & " + formatted[-1]
    # 8+ authors: first 6, then ... then last
    formatted = []
    for a in authors[:6]:
        parts = a.split()
        if len(parts) >= 2:
            initials = "".join(p[0] + ". " for p in parts[:-1]).strip()
            formatted.append(f"{parts[-1]}, {initials}")
    parts = authors[-1].split()
    last = (
        f"{parts[-1]}, {''.join(p[0] + '. ' for p in parts[:-1])}".strip()
        if len(parts) >= 2
        else authors[-1]
    )
    return ", ".join(formatted) + f", ... {last}"


def _format_authors_mla(authors: list[str]) -> str:
    if not authors:
        return ""
    if len(authors) == 1:
        parts = authors[0].split()
        if len(parts) >= 2:
            return f"{parts[-1]}, {' '.join(parts[:-1])}"
        return authors[0]
    if len(authors) == 2:
        p0 = authors[0].split()
        p1 = authors[1].split()
        a0 = f"{p0[-1]}, {' '.join(p0[:-1])}" if len(p0) >= 2 else authors[0]
        a1 = " ".join(p1) if len(p1) >= 2 else authors[1]
        return f"{a0}, and {a1}"
    p0 = authors[0].split()
    first = f"{p0[-1]}, {' '.join(p0[:-1])}" if len(p0) >= 2 else authors[0]
    return f"{first}, et al."


def _format_apa(
    authors: list[str],
    year: int | None,
    title: str,
    journal: str,
    doi: str | None,
) -> str:
    author_str = _format_authors_apa(authors) or "Anonymous"
    year_str = f"({year})" if year else "(n.d.)"
    citation = f"{author_str} {year_str}. {title}."
    if journal:
        citation += f" *{journal}*."
    if doi:
        citation += f" https://doi.org/{doi}"
    return citation


def _format_mla(
    authors: list[str],
    year: int | None,
    title: str,
    journal: str,
    doi: str | None,
) -> str:
    author_str = _format_authors_mla(authors) or "Anonymous"
    citation = f'{author_str}. "{title}."'
    if journal:
        citation += f" *{journal}*"
    if year:
        citation += f", {year}"
    if doi:
        citation += f". doi:{doi}"
    citation += "."
    return citation


def _format_chicago(
    authors: list[str],
    year: int | None,
    title: str,
    journal: str,
    doi: str | None,
) -> str:
    if not authors:
        author_str = "Anonymous"
    elif len(authors) == 1:
        author_str = authors[0]
    elif len(authors) <= 3:
        author_str = ", ".join(authors[:-1]) + ", and " + authors[-1]
    else:
        author_str = authors[0] + " et al."
    citation = f'{author_str}. "{title}."'
    if journal:
        citation += f" *{journal}*"
    if year:
        citation += f" ({year})"
    if doi:
        citation += f". https://doi.org/{doi}"
    citation += "."
    return citation
