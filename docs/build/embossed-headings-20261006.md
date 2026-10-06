# Tonal embossed headings

R0 typography revision. Replaced the contrasting heading fills and dark outlines with deeper shades of each card's own color. A light upper edge and soft lower shadow create a raised, beveled appearance. Heading size stays 30px bold Basetica. Prices, fees, card gradients and black shapes remain unchanged.

124 web tests and production build pass, with the existing dependency build warning. Browser checks pass at 320, 390, 768, 900, 1024 and 1440px: intended tonal colors, highlight/shadow rendering, removed outlines, no heading clipping or horizontal overflow, keyboard selection and preserved black details/dots. The large heading fills exceed 3:1 contrast against each gradient stop. Zero page errors. Mobile and desktop screenshots inspected. Evidence: `artifacts/embossed-headings/`.

Local Preview refreshed. No push or deployment. No purchase logic changes.
