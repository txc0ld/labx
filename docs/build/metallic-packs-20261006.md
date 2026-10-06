# Metallic pack gradients

R0 color revision. Bronze now uses warm bronze/copper tones, Silver uses silver-grey tones, and Gold uses gold tones. Each card has a static diagonal gradient with a soft highlight. Entry retains a darker olive gradient; Platinum retains the #CCFF00 lime identity. Larger Basetica text, spacing and black dots are preserved. Bronze text is black against its lighter gradient for legibility.

124 web tests and production build pass, with the existing dependency build warning. Browser checks pass at 320, 390, 768 and 1440px: gradient rendering, expected fallback colors, black dots, selection and no horizontal overflow. Each gradient stop has at least 4.5:1 text contrast. Zero page errors. Mobile screenshot inspected. Evidence: `artifacts/metallic-packs/`.

Local Preview refreshed. No push or deployment. No purchase behavior changes.
