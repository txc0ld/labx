# LABx design brief

LABx is a Sepolia membership bench for one escrowed piece at a time. The interface is a physical lab console: pearlescent instrument panels, mirrored chrome hardware, and fluorescent cables that link those panels to each other. It is not a flat marketing site and it is not a glassmorphism theme.

## Source of truth

| File | Role |
| --- | --- |
| `design/reference/moodboard-style-source.png` | Materials, lighting, cables, chrome, chunky controls, lavender field. The figure in this photograph is excluded from the product. |
| `design/reference/colour-tokens.png` | Exact UI colour tokens. |
| `web/public/lab/hero-linked-panels.jpg` | Hero hardware: terminal, chrome junction, glossy filter panel, fluoro cables. No figure. |
| `web/public/lab/filter-panel.jpg` | Glossy filter panel with chunky buttons and a chrome port. |
| `web/public/lab/terminal-panel.jpg` | Purple terminal housing, chrome bezel, fluoro cable. |
| `web/public/lab/chrome-fluoro-run.jpg` | Mirrored chrome plumbing and fluoro cables between two panels. |

Photographs are props. Interface words are HTML set in Space Grotesk and IBM Plex Mono. Do not treat lettering baked into a render as navigation or data.

## Hard exclusions

- No human, head, face, figure, mannequin, eye, or wireframe body in UI, icons, alt text, or generated assets.
- Tubes, cables, ports, and junctions connect panels to panels. They do not connect to a character.
- No `backdrop-filter` and no frosted-glass default. Gloss is a painted pearlescent surface or a photograph of a glossy panel.
- No public floor and no published private commitment. Membership pack prices are shown because they are the product.
- Do not call packs tickets. The product word is membership pack. The chance word is bonus entry.
- Ethereum mainnet is not a theme, a network option, or a deploy target.

## Colour tokens

Use these values exactly.

| Use | Token |
| --- | --- |
| Field | `#E6D8FA` soft lavender, matching the moodboard ground |
| Lavender accent | `#B09BE8` |
| Purple accent, primary CTA, active focus alternate | `#8049FF` |
| Text on purple | `#FFFFFF` |
| Lime, warning fill, active pack, focus ring | `#B9FF87` with black text |
| Pink, error fill, destructive | `#FF79C0` with black text |
| Mint, success lamp, fluoro cable | `#8FFFB6` |
| Body text | `#000000` |
| Secondary text | `#3C3B3C` |
| Text on the dark terminal | `#DBDBDB` |
| Inset ceramic well | `#D4DED2` |
| Terminal ground | `#140C2E` |

Fluoro `#B9FF87`, `#FF79C0`, `#8FFFB6`, `#8049FF`, and `#B09BE8` are for cables, ports, status lamps, active states, and CTAs. They sit bright against the matte-pearl panels. Body copy stays black or charcoal on pearl and on lime or pink fills.

Sage `#D4DED2` is the pigment inside inset wells. The page field is lavender, because that is the moodboard ground.

## Materials

**Lavender field.** The page background is a soft lilac wash with a hairline purple wordmark (`LAB`) stroked, not filled, behind the console.

**Pearlescent panel.** A stacked gradient: white highlight at the top left, a pink fluoro kiss, a purple falloff, a mint kiss at the lower left, then a lilac body. Inner top highlight, soft lower shade. This is the card.

**Mirrored chrome bezel.** A tight metallic gradient (white, steel, white, graphite, white) wraps every photograph and the outer frame of a major panel. Specular, not blurred glass.

**Inset well.** Sage ceramic pressed in with an inner shadow. Use it for agreements, tables, and the complimentary-entry block.

**Purple terminal.** Dark violet instrument screen for wallet, chain, and VRF copy. Text on it is `#DBDBDB`, not body black.

**Chunky controls.** Buttons are 16px radius, with a 6px solid foot and an inset top highlight. Pressing translates them down onto the foot. Lime and pink buttons use black text. Purple buttons use white text. The active pack key is lime.

**Fluoro cable and chrome port.** SVG plumbing between sections: steel tube, black port, fluoro core in mint, purple, lime, or pink. A dash animation runs along the cable. Photographs repeat the same hardware at hero scale.

## Motion

Restrained.

- Cable dash offset, about 9 seconds, linear.
- A small Lottie pulse (`web/public/lab/flow.json`) travels once across the hero kicker. It does not loop a character.
- Button press is a 5px translate.
- `prefers-reduced-motion: reduce` stops the cable, the Lottie, and the button travel.

No parallax, no page-load theatrics, no glass shimmer.

## Surfaces

**Explore.** Header with chrome port mark, chunky nav, Sepolia pill. Hero is three linked objects: terminal photograph, pearl copy panel, filter photograph. The cable-run photograph sits underneath as the physical link. Then a lime warning strip (black text) that this is Sepolia. Then a two-up grid of piece cards in chrome bezels.

**Piece.** Chrome-framed photograph beside the pack console. Packs are chunky keys from Entry to Platinum. Each key shows bonus entries, USDC price, remaining supply, and the 5 USDC lab fee. Three real checkboxes gate the purchase. The commitment hash is mono type, not a private number.

**Studio.** Pearl form for a new piece, filter photograph as the console, then one pearl row per piece with escrow, open, close, snapshot, draw, reveal, settle, and cancel. The private commitment field is cleared after submit and is never rendered on explore, the piece page, or fairness.

**Profile.** Terminal readout for wallet and points. Connect Sepolia, or use the bench wallet. Entries table with expiry. Receipt email. Agreement log.

**Fairness.** Three locks: escrow, commit, VRF. A table per piece. Revealed rows may show the public summary. They do not show the private commitment.

**Draw rules.** The complimentary entry lives here, after the rules, not in the header and not on the hero.

## Accessibility

- Landmarks: header, nav, main, footer. Skip link.
- One h1 per page. Buttons are buttons. Pack keys are radios.
- Labels point at inputs. Errors use `role="alert"`. Status uses `role="status"`.
- Checkboxes keep the native control and `accent-color: #8049FF`.
- Focus is a 3px lime ring, purple on lime controls.
- Warning and error fills use black text.
- Decorative plumbing has an accessible name. Piece photographs describe hardware, never a person.

## Copy

Short, physical, specific. “Membership pack”, “bonus entries”, “escrow”, “snapshot”, “lab fee”, “Sepolia”. Prices are pack prices. The 5 USDC lab fee is always visible next to the pack.

## Do not

- Add a figure back into a plate “for warmth”.
- Flatten the panels into solid grey cards.
- Put body text in fluoro green or pink.
- Use the prop lettering inside the photographs as real labels.
- Promote the complimentary entry on explore.
