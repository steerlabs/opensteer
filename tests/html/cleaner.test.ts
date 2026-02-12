import { describe, expect, it } from 'vitest'
import {
    cleanForAction,
    cleanForExtraction,
    cleanForFull,
    cleanForScrollable,
} from '../../src/html/cleaner.js'

describe('cleanForAction', () => {
    it('removes hidden and noise content but keeps clickable context', () => {
        const html = `
      <html c="1">
        <body c="2">
          <script>window.bad = true</script>
          <button c="3" id="submit" data-oversteer-interactive="1" aria-label="Submit order">
            Submit
          </button>
          <div c="4" data-oversteer-hidden="1">Hidden copy</div>
          <div c="5" style="display:none">Also hidden</div>
        </body>
      </html>
    `

        const cleaned = cleanForAction(html)
        expect(cleaned).toContain('Submit')
        expect(cleaned).toContain('c="3"')
        expect(cleaned).not.toContain('window.bad')
        expect(cleaned).not.toContain('Hidden copy')
    })
})

describe('cleanForExtraction', () => {
    it('strips all non-essential attributes', () => {
        const html = `
      <section c="1" id="main" class="container" style="color:red" data-testid="main">
        <div c="2" onclick="alert(1)" role="region" aria-label="Products">
          <span c="3">Product name</span>
        </div>
      </section>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('Product name')
        expect(cleaned).not.toContain('id=')
        expect(cleaned).not.toContain('class=')
        expect(cleaned).not.toContain('style=')
        expect(cleaned).not.toContain('onclick=')
        expect(cleaned).not.toContain('role=')
        expect(cleaned).not.toContain('aria-label=')
        expect(cleaned).not.toContain('data-testid=')
    })

    it('preserves c attribute on elements', () => {
        const html = `<div c="1"><span c="2">Hello</span></div>`

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('c="2"')
    })

    it('preserves href on anchor elements', () => {
        const html = `
      <div c="1">
        <a c="2" href="/products/desk" class="link" title="Desk" data-track="click">
          Atlas Desk
        </a>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('href="/products/desk"')
        expect(cleaned).not.toContain('class=')
        expect(cleaned).not.toContain('title=')
        expect(cleaned).not.toContain('data-track=')
    })

    it('preserves src, srcset, and alt on img elements', () => {
        const html = `
      <div c="1">
        <img c="2" src="/img/photo.jpg" srcset="/img/photo-2x.jpg 2x" alt="A photo" class="thumb" width="200" height="150" loading="lazy" />
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('src="/img/photo.jpg"')
        expect(cleaned).toContain('srcset="/img/photo-2x.jpg 2x"')
        expect(cleaned).toContain('alt="A photo"')
        expect(cleaned).not.toContain('class=')
        expect(cleaned).not.toContain('width=')
        expect(cleaned).not.toContain('height=')
        expect(cleaned).not.toContain('loading=')
    })

    it('truncates long alt text on images', () => {
        const longAlt = 'A'.repeat(200)
        const html = `<div c="1"><img c="2" src="/a.jpg" alt="${longAlt}" /></div>`

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('alt="')
        // Alt should be truncated to 150 chars
        expect(cleaned).not.toContain(longAlt)
    })

    it('preserves src and srcset on source inside picture', () => {
        const html = `
      <div c="1">
        <picture c="2">
          <source c="3" srcset="/img/hero.webp" type="image/webp" media="(min-width: 800px)" />
          <img c="4" src="/img/hero.jpg" alt="Hero" />
        </picture>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('srcset="/img/hero.webp"')
        expect(cleaned).toContain('src="/img/hero.jpg"')
        expect(cleaned).not.toContain('type=')
        expect(cleaned).not.toContain('media=')
    })

    it('does not preserve source attrs outside of picture', () => {
        const html = `
      <div c="1">
        <video c="2">
          <source c="3" src="/video.mp4" type="video/mp4" />
        </video>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        // Source not inside a <picture> should not get src preserved
        expect(cleaned).not.toContain('src="/video.mp4"')
    })

    it('always preserves anchor elements even when empty', () => {
        const html = `
      <div c="1">
        <a c="2" href="/page"></a>
        <a c="3" href="/other">Link text</a>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        // Both anchors should be preserved (leaveLinks=true)
        expect(cleaned).toContain('href="/page"')
        expect(cleaned).toContain('href="/other"')
        expect(cleaned).toContain('Link text')
    })

    it('flattens wrapper elements without direct text', () => {
        const html = `
      <div c="1">
        <div c="2">
          <div c="3">
            <span c="4">Deeply nested text</span>
          </div>
        </div>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('Deeply nested text')
        // Intermediate wrappers without direct text should be collapsed
        expect(cleaned).not.toContain('c="1"')
        expect(cleaned).not.toContain('c="2"')
        expect(cleaned).not.toContain('c="3"')
    })

    it('keeps elements with direct text content', () => {
        const html = `
      <div c="1">
        <p c="2">First paragraph</p>
        <p c="3">Second paragraph</p>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('First paragraph')
        expect(cleaned).toContain('Second paragraph')
    })

    it('removes empty leaf elements', () => {
        const html = `
      <div c="1">
        <span c="2"></span>
        <div c="3"></div>
        <p c="4">Content</p>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('Content')
        // Empty elements without text should be removed
        expect(cleaned).not.toContain('c="2"')
        expect(cleaned).not.toContain('c="3"')
    })

    it('removes script, style, and hidden elements', () => {
        const html = `
      <html c="1">
        <head c="2"><style>body { color: red }</style></head>
        <body c="3">
          <script>alert("xss")</script>
          <noscript>Enable JS</noscript>
          <div c="4" data-oversteer-hidden="1">Hidden</div>
          <div c="5" style="display:none">Also hidden</div>
          <p c="6">Visible content</p>
        </body>
      </html>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('Visible content')
        expect(cleaned).not.toContain('<script>')
        expect(cleaned).not.toContain('<style>')
        expect(cleaned).not.toContain('<noscript>')
        expect(cleaned).not.toContain('Hidden')
        expect(cleaned).not.toContain('Also hidden')
    })

    it('removes comments', () => {
        const html = `
      <div c="1"><!-- TODO: remove this -->
        <span c="2">Text</span>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('Text')
        expect(cleaned).not.toContain('TODO')
        expect(cleaned).not.toContain('<!--')
    })

    it('deduplicates images with the same src', () => {
        const html = `
      <div c="1">
        <img c="2" src="/img/logo.png" alt="Logo" />
        <img c="3" src="/img/logo.png" alt="Logo again" />
        <img c="4" src="/img/other.png" alt="Other" />
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('src="/img/logo.png"')
        expect(cleaned).toContain('src="/img/other.png"')
        // Second occurrence of the same src should be removed
        expect(cleaned).not.toContain('Logo again')
    })

    it('preserves img elements inside wrappers during flattening', () => {
        const html = `
      <div c="1">
        <div c="2">
          <div c="3">
            <img c="4" src="/photo.jpg" alt="Photo" />
          </div>
        </div>
      </div>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('src="/photo.jpg"')
        expect(cleaned).toContain('alt="Photo"')
    })

    it('produces indented serializer output with inlined short text', () => {
        const html = `<div c="1"><p c="2">Short text</p></div>`

        const cleaned = cleanForExtraction(html)
        // The serializer inlines single short text children on one line
        expect(cleaned).toMatch(/<p c="2">Short text<\/p>/)
    })

    it('skips html, head, body wrapper tags in output', () => {
        const html = `
      <html c="1">
        <head c="2"></head>
        <body c="3">
          <p c="4">Hello</p>
        </body>
      </html>
    `

        const cleaned = cleanForExtraction(html)
        expect(cleaned).toContain('Hello')
        expect(cleaned).not.toContain('<html')
        expect(cleaned).not.toContain('<head')
        expect(cleaned).not.toContain('<body')
    })

    it('handles realistic search results page structure', () => {
        const html = `
      <html c="1">
        <body c="2">
          <script>var tracking = {}</script>
          <style>.result { margin: 10px }</style>
          <div c="3" id="search" class="search-results" role="main">
            <div c="4" class="result-wrapper" data-ved="abc123">
              <div c="5" class="result">
                <h3 c="6" class="title"><a c="7" href="https://example.com/magnesium" class="link" data-track="result-1">Magnesium - Health Fact Sheet</a></h3>
                <div c="8" class="snippet-wrapper">
                  <span c="9" class="url" style="color:green">example.com</span>
                  <span c="10" class="snippet">Magnesium is an essential mineral involved in over 300 enzymatic reactions.</span>
                </div>
              </div>
            </div>
            <div c="11" class="result-wrapper" data-ved="def456">
              <div c="12" class="result">
                <h3 c="13" class="title"><a c="14" href="https://example.org/mg" class="link" data-track="result-2">Why Magnesium Matters</a></h3>
                <div c="15" class="snippet-wrapper">
                  <span c="16" class="url" style="color:green">example.org</span>
                  <span c="17" class="snippet">Learn about the benefits of magnesium for heart health.</span>
                </div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `

        const cleaned = cleanForExtraction(html)

        // Content is preserved
        expect(cleaned).toContain('Magnesium - Health Fact Sheet')
        expect(cleaned).toContain('Why Magnesium Matters')
        expect(cleaned).toContain('over 300 enzymatic reactions')
        expect(cleaned).toContain('heart health')

        // Links are preserved with href
        expect(cleaned).toContain('href="https://example.com/magnesium"')
        expect(cleaned).toContain('href="https://example.org/mg"')

        // All non-essential attributes are stripped
        expect(cleaned).not.toContain('class=')
        expect(cleaned).not.toContain('id=')
        expect(cleaned).not.toContain('role=')
        expect(cleaned).not.toContain('data-ved=')
        expect(cleaned).not.toContain('data-track=')
        expect(cleaned).not.toContain('style=')

        // Scripts and styles removed
        expect(cleaned).not.toContain('<script>')
        expect(cleaned).not.toContain('<style>')
        expect(cleaned).not.toContain('tracking')

        // Output should be significantly shorter than input
        expect(cleaned.length).toBeLessThan(html.length * 0.5)
    })

    it('returns empty string for empty or whitespace input', () => {
        expect(cleanForExtraction('')).toBe('')
        expect(cleanForExtraction('   ')).toBe('')
    })
})

describe('cleanForScrollable', () => {
    it('keeps scrollable containers and marker attrs', () => {
        const html = `
      <div c="1">
        <div c="2" data-oversteer-scrollable="y" class="panel">
          <p c="3">Scrollable</p>
        </div>
        <div c="4">Static</div>
      </div>
    `

        const cleaned = cleanForScrollable(html)
        expect(cleaned).toContain('data-oversteer-scrollable="y"')
        expect(cleaned).toContain('c="2"')
        expect(cleaned).toContain('Static')
    })
})

describe('cleanForFull', () => {
    it('removes script, style, and noise but keeps broad page structure', () => {
        const html = `
      <html c="1">
        <head c="2"><style>body{display:none}</style></head>
        <body c="3"><!-- comment --><main c="4">Visible</main></body>
      </html>
    `

        const cleaned = cleanForFull(html)
        expect(cleaned).toContain('Visible')
        expect(cleaned).not.toContain('<style>')
        expect(cleaned).not.toContain('comment')
    })
})
