# Sixtyfour H1 preview

R0 typography update following the user's final font choice. Replaced the Pirulen H1 loader with Sixtyfour Regular 400 through Next's Google font loader. The production build self-hosts the font. Basetica remains on card titles, controls and body text. Existing shortened page headings and raffle names are unchanged. Adjusted the collection heading's container-relative size for Sixtyfour's wider monospace metrics, preserving the complete title and scramble animation. No added runtime dependency or purchase/contract behavior changes.

Source: https://fonts.google.com/specimen/Sixtyfour

Verification against this code candidate: 124 web tests pass, production build exits 0 including type validation, and git diff whitespace validation passes. The pre-existing ox/viem dependency warning remains. Headless Chromium passed 14 routes at 320, 390, 768 and 1440px, 56 combinations. Rendered-font inspection confirms Sixtyfour on H1s and Basetica on navigation. No clipped headings, horizontal page overflow or page errors. Hover scramble resolves and the reduced-motion title remains visible. Desktop and mobile home and mobile detail screenshots inspected after fonts, images and entry animations settled. Evidence is in artifacts/sixtyfour-headings/.

T3 Preview was navigated to the rebuilt local home page. Its screenshot command failed; visual checks used the previously authorized headless browser. No push or deployment. Model usage is unavailable; no delegated workers required for this R0 change.
