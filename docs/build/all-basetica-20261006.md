# Basetica throughout

R0 typography follow-up to the user's request to use the supplied font for everything. Removed Space Grotesk and IBM Plex Mono loading and switched all explicit font rules to local Basetica. Headings inherit the body family. Prices, metadata, badges and technical labels now use the same family. The supplied logo remains an image. The supplied font is regular weight 400; heavier emphasis is synthesized by the browser.

124 web tests pass. Production build exits 0, including type validation, with the existing dependency warning. Browser verification passes for home, raffle detail and guide at 320, 390, 768 and 1440px. Chrome's rendered-font inspection confirms Basetica in navigation, headings, pack prices, selection labels, fee details, deadline and button text where present. No horizontal overflow or page errors. Mobile pack screenshot inspected. Evidence: `artifacts/all-basetica/`.

Local Preview refreshed. No push or deployment. No purchase behavior changes or dependencies added.
