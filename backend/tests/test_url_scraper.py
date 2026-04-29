"""URL scraper error handling, the layered extractor's product-page
support, and the Playwright fallback path. All HTTP and Playwright
calls are mocked so tests run in milliseconds without network access."""

from __future__ import annotations

import httpx
import pytest
import respx

from app.ingestion import url as url_module
from app.ingestion.url import UrlScrapeError, scrape_url


ARTICLE_HTML = """
<!doctype html>
<html>
<head><title>Return Policy</title></head>
<body>
  <nav>Home · About · Contact</nav>
  <main>
    <article>
      <h1>Return Policy</h1>
      <p>We accept returns for damaged items within thirty days of purchase.
      Please contact support with your order number and a photo of the damage.</p>
      <p>Refunds are issued to the original payment method within five to seven
      business days after the returned item is received and inspected.</p>
      <p>Items used beyond inspection purposes are not eligible for refund.</p>
    </article>
  </main>
  <footer>Copyright 2026</footer>
</body></html>
"""


@respx.mock
async def test_scrape_happy_path_extracts_main_content() -> None:
    respx.get("https://example.com/policy").mock(
        return_value=httpx.Response(
            200,
            text=ARTICLE_HTML,
            headers={"content-type": "text/html; charset=utf-8"},
        )
    )

    result = await scrape_url("https://example.com/policy")

    assert "thirty days" in result.text
    assert "Copyright" not in result.text   # footer filtered
    assert "Home · About" not in result.text  # nav filtered
    assert result.title == "Return Policy"
    assert result.domain == "example.com"


@respx.mock
async def test_scrape_behind_login_401_raises(monkeypatch) -> None:
    """401 is terminal — a headless browser would also be locked out."""
    respx.get("https://example.com/private").mock(
        return_value=httpx.Response(401, text="login required")
    )

    async def _boom(_url):
        raise AssertionError("Playwright fallback must not run on HTTP 401")

    monkeypatch.setattr(url_module, "_scrape_rendered", _boom)
    monkeypatch.setattr(url_module.settings, "playwright_enabled", True)

    with pytest.raises(UrlScrapeError, match="login"):
        await scrape_url("https://example.com/private")


@respx.mock
async def test_scrape_404_raises() -> None:
    respx.get("https://example.com/missing").mock(
        return_value=httpx.Response(404, text="not found")
    )
    with pytest.raises(UrlScrapeError, match="not found"):
        await scrape_url("https://example.com/missing")


@respx.mock
async def test_scrape_non_html_raises() -> None:
    respx.get("https://example.com/data.json").mock(
        return_value=httpx.Response(
            200,
            text="{}",
            headers={"content-type": "application/json"},
        )
    )
    with pytest.raises(UrlScrapeError, match="Unsupported content type"):
        await scrape_url("https://example.com/data.json")


async def test_scrape_rejects_non_http_scheme() -> None:
    with pytest.raises(UrlScrapeError, match="http"):
        await scrape_url("ftp://example.com/thing")


# ────────────────────────────────────────────────────────────────────────────
# Layered extraction — the bit that lets us handle real product pages
# ────────────────────────────────────────────────────────────────────────────

# A representative e-commerce product page: trafilatura's article filter
# rejects this layout entirely (no <article> element, mostly nav and
# product chrome) but the JSON-LD block carries the full description.
# This is exactly the "many product pages are JS-rendered" failure mode
# the reviewer flagged: even when the page IS rendered, trafilatura
# alone returns nothing.
PRODUCT_PAGE_HTML = """
<!doctype html>
<html>
<head>
  <title>Aurora Wireless Headphones — Acme</title>
  <meta property="og:title" content="Aurora Wireless Headphones">
  <meta name="description" content="Studio-grade wireless headphones with 40-hour battery life.">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Aurora Wireless Headphones",
    "description": "The Aurora delivers studio-grade sound in a comfortable, lightweight wireless package. Active noise cancellation, 40-hour battery life, and ultra-low-latency Bluetooth 5.3 keep you immersed for the long haul. Hand-stitched memory-foam earcups conform to your head over time. The companion app supports custom EQ profiles, spatial audio mixing, and firmware updates.",
    "brand": {"@type": "Brand", "name": "Acme"},
    "offers": {
      "@type": "Offer",
      "price": "299.00",
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "description": "Free standard shipping in the continental US. Returns accepted within 30 days for a full refund."
    }
  }
  </script>
</head>
<body>
  <header><nav>Home · Shop · Cart</nav></header>
  <main>
    <h1>Aurora Wireless Headphones</h1>
    <div class="product-grid">
      <img src="/aurora.jpg" alt="Aurora">
      <div class="buy-box">
        <span class="price">$299.00</span>
        <button>Add to cart</button>
      </div>
    </div>
  </main>
  <footer>© Acme</footer>
</body></html>
"""


@respx.mock
async def test_scrape_extracts_product_page_via_jsonld() -> None:
    """A JS-built product page where trafilatura's article filter would
    return nothing. The layered extractor must fall through to the
    JSON-LD / structured-data layer and surface the description."""
    respx.get("https://shop.example.com/aurora").mock(
        return_value=httpx.Response(
            200,
            text=PRODUCT_PAGE_HTML,
            headers={"content-type": "text/html; charset=utf-8"},
        )
    )

    result = await scrape_url("https://shop.example.com/aurora")

    # JSON-LD description came through.
    assert "studio-grade sound" in result.text
    assert "40-hour battery life" in result.text
    # The offer description (a nested JSON-LD field) also came through.
    assert "Returns accepted within 30 days" in result.text
    # Title resolved from <title>.
    assert result.title is not None and "Aurora" in result.title
    # Static path succeeded — no need to render.
    assert result.rendered is False


# ────────────────────────────────────────────────────────────────────────────
# Playwright fallback
# ────────────────────────────────────────────────────────────────────────────

# A page that returns 200 OK but has only nav/footer chrome — trafilatura
# will extract nothing AND the JSON-LD/body fallback layer also has
# nothing to chew on. This is what JS-rendered SPAs look like from a
# plain GET request.
EMPTY_SHELL_HTML = """
<!doctype html>
<html><head><title>Loading…</title></head>
<body>
  <nav>Home</nav>
  <div id="root"></div>
  <footer>(c) 2026</footer>
</body></html>
"""


@respx.mock
async def test_scrape_static_succeeds_skips_playwright_fallback(monkeypatch) -> None:
    """When the static path returns enough content, the headless browser
    must not be invoked at all (it's expensive)."""
    respx.get("https://example.com/policy").mock(
        return_value=httpx.Response(
            200,
            text=ARTICLE_HTML,
            headers={"content-type": "text/html; charset=utf-8"},
        )
    )

    async def _boom(_url):
        raise AssertionError("Playwright fallback must not run on static success")

    monkeypatch.setattr(url_module, "_scrape_rendered", _boom)

    result = await scrape_url("https://example.com/policy")
    assert "thirty days" in result.text
    assert result.rendered is False


@respx.mock
async def test_scrape_falls_back_to_playwright_when_static_is_empty(
    monkeypatch,
) -> None:
    """SPA-style URL: static returns 200 with an empty shell, fallback
    runs and returns the hydrated content."""
    respx.get("https://spa.example.com/product").mock(
        return_value=httpx.Response(
            200,
            text=EMPTY_SHELL_HTML,
            headers={"content-type": "text/html"},
        )
    )

    calls: list[str] = []

    async def _fake_rendered(url: str):
        calls.append(url)
        return ("This is the hydrated product description. " * 10, "Product Page")

    monkeypatch.setattr(url_module, "_scrape_rendered", _fake_rendered)
    monkeypatch.setattr(url_module.settings, "playwright_enabled", True)

    result = await scrape_url("https://spa.example.com/product")

    assert calls == ["https://spa.example.com/product"]
    assert result.rendered is True
    assert "hydrated" in result.text
    assert result.title == "Product Page"


@respx.mock
async def test_scrape_falls_back_to_playwright_on_403(monkeypatch) -> None:
    """Many real product pages return 403 to plain httpx because of
    Cloudflare/Akamai-style bot detection. A real browser usually
    passes — so 403 must trigger the rendered fallback, not be
    treated as terminal."""
    respx.get("https://shop.example.com/blocked").mock(
        return_value=httpx.Response(403, text="Access denied")
    )

    calls: list[str] = []

    async def _fake_rendered(url: str):
        calls.append(url)
        return (
            "Behind the bot wall the page contains the actual product copy. "
            * 10,
            "Blocked Product",
        )

    monkeypatch.setattr(url_module, "_scrape_rendered", _fake_rendered)
    monkeypatch.setattr(url_module.settings, "playwright_enabled", True)

    result = await scrape_url("https://shop.example.com/blocked")

    assert calls == ["https://shop.example.com/blocked"]
    assert result.rendered is True
    assert "actual product copy" in result.text


@respx.mock
async def test_scrape_403_surfaces_when_playwright_disabled(monkeypatch) -> None:
    """If Playwright is opted out, a 403 must surface as the original
    UrlScrapeError instead of silently disappearing."""
    respx.get("https://shop.example.com/blocked").mock(
        return_value=httpx.Response(403, text="Access denied")
    )

    async def _boom(_url):
        raise AssertionError("Playwright fallback must not run when disabled")

    monkeypatch.setattr(url_module, "_scrape_rendered", _boom)
    monkeypatch.setattr(url_module.settings, "playwright_enabled", False)

    with pytest.raises(UrlScrapeError, match="HTTP 403"):
        await scrape_url("https://shop.example.com/blocked")


@respx.mock
async def test_scrape_does_not_fall_back_when_playwright_disabled(
    monkeypatch,
) -> None:
    """Operator opted out of the headless fallback — the empty-shell case
    must surface as the original UrlScrapeError instead of silently
    spinning up Chromium."""
    respx.get("https://spa.example.com/product").mock(
        return_value=httpx.Response(
            200,
            text=EMPTY_SHELL_HTML,
            headers={"content-type": "text/html"},
        )
    )

    async def _boom(_url):
        raise AssertionError("Playwright fallback must not run when disabled")

    monkeypatch.setattr(url_module, "_scrape_rendered", _boom)
    monkeypatch.setattr(url_module.settings, "playwright_enabled", False)

    with pytest.raises(UrlScrapeError, match="too short"):
        await scrape_url("https://spa.example.com/product")


@respx.mock
async def test_scrape_does_not_fall_back_on_terminal_4xx(monkeypatch) -> None:
    """HTTP 404 (and 401, 410) are unrecoverable — a headless browser
    would also be unable to fetch them. We must raise immediately and
    never invoke the fallback, even with Playwright enabled."""
    respx.get("https://example.com/missing").mock(
        return_value=httpx.Response(404, text="not found")
    )

    async def _boom(_url):
        raise AssertionError("Playwright fallback must not run on terminal 4xx")

    monkeypatch.setattr(url_module, "_scrape_rendered", _boom)
    monkeypatch.setattr(url_module.settings, "playwright_enabled", True)

    with pytest.raises(UrlScrapeError, match="not found"):
        await scrape_url("https://example.com/missing")
